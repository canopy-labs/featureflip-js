import type { FeatureflipConfig, ResolvedConfig } from '../config.js';
import { resolveConfig } from '../config.js';
import { FlagStore } from './store.js';
import { evaluate } from './evaluator.js';
import { EventProcessor, EventSendError } from './events.js';
import type {
  EvaluationContext,
  EvaluationDetail,
  EvaluationEvent,
  EvaluationInspector,
  EvaluationReason,
  FlagDto,
  FlagUpdateListener,
  GetFlagsResponse,
  StreamFlagUpdatedEvent,
} from './types.js';
import type { EventSourceLike, Platform } from '../platform/types.js';
import {
  MalformedPayloadError,
  validateFlag,
  validateSnapshot,
} from './validate-snapshot.js';
import {
  dropUnevaluableEntities,
  unevaluableFlagReason,
} from './unevaluable.js';

/**
 * Resolve the built-in user id for an analytics event from either the
 * canonical `user_id` field or its `userId` camelCase alias — mirroring the
 * two-way alias the evaluator applies for rollout bucketing. Without this the
 * event's `userId` is silently null whenever a caller passes a `userId`-keyed
 * context (a documented-valid shape), leaving analytics unattributed.
 */
function resolveEventUserId(
  context: EvaluationContext,
): string | undefined {
  const raw = context.user_id ?? context.userId;
  return raw != null ? String(raw) : undefined;
}

/**
 * The runtime type a typed accessor requires of the value a flag serves, as
 * reported by `typeof`. Used to detect a type-mismatched read (#2281), which
 * TypeScript cannot catch on its own: its type parameters are erased, so
 * `boolVariation` would otherwise hand back whatever the flag actually served.
 */
export type ExpectedValueType = 'boolean' | 'string' | 'number';

/**
 * Internal shared core owning all expensive resources of a FeatureflipClient:
 * platform, HTTP fetches, event processor, SSE connection, polling timer.
 *
 * Refcounted: multiple FeatureflipClient handles can share one core, and the
 * real shutdown runs only when the last handle is disposed. Constructed either
 * by the static factory in `client.ts` or directly by `createForTesting`.
 *
 * JS is single-threaded, so the refcount is a plain number — no atomic
 * primitives or locking required.
 *
 * @internal
 */
export class SharedFeatureflipCore {
  readonly config: ResolvedConfig;
  private readonly store: FlagStore;
  private readonly events: EventProcessor;
  private readonly platform: Platform;
  private readonly inspectors: EvaluationInspector[];
  private readonly updateListeners = new Set<FlagUpdateListener>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private eventSource: EventSourceLike | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private streamRetryCount = 0;
  private streamRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Number of outstanding handles (including the one returned by the factory). */
  private refCount = 1;

  /** Set by the factory after inserting into the owning map so Shutdown can remove itself. */
  private owningMap: Map<string, SharedFeatureflipCore> | null = null;
  private owningKey: string | null = null;

  constructor(config: FeatureflipConfig, platform: Platform) {
    this.config = resolveConfig(config);
    this.store = new FlagStore();
    this.platform = platform;
    // Read from the RAW config — inspectors are deliberately not part of
    // ResolvedConfig (functions aren't structurally comparable, and a differing
    // callback must not trigger the config-equality warning). Filter to
    // functions defensively: JS callers bypass the type system.
    this.inspectors = (config.inspectors ?? []).filter(
      (i): i is EvaluationInspector => typeof i === 'function',
    );

    this.events = new EventProcessor(
      {
        sendEvents: async (request) => {
          const response = await this.platform.fetch(
            `${this.config.baseUrl}/v1/sdk/events`,
            {
              method: 'POST',
              headers: this.headers(),
              body: JSON.stringify(request),
            },
          );
          // `fetch` resolves for 4xx/5xx as readily as for 200, so without this
          // check a rejected batch looked exactly like a delivered one — the
          // events were dropped with no log and no counter (#2456).
          if (!response.ok) throw new EventSendError(response.status);
        },
      },
      this.config.flushInterval,
      this.config.flushBatchSize,
    );

    // The store's own notifier swallows listener errors, which would silently
    // skip the remaining subscribers. Fan out here instead so each caller's
    // listener is isolated and a failure is at least warned about.
    this.store.onChange((keys) => this.notifyUpdateListeners(keys));
  }

  /**
   * Test-only constructor. Bypasses network: accepts pre-populated flag DTOs
   * and marks the core as initialized. Used by FeatureflipClient.forTesting.
   */
  static createForTesting(flags: FlagDto[]): SharedFeatureflipCore {
    const noopPlatform: Platform = {
      md5: () => new Uint8Array(16),
      createEventSource: () => ({
        addEventListener: () => {},
        close: () => {},
        readyState: 2,
      }),
      fetch: async () => new Response(),
    };
    const core = new SharedFeatureflipCore(
      { sdkKey: 'test-key', baseUrl: 'http://localhost' },
      noopPlatform,
    );
    core.store.init(flags, [], 1);
    core.initialized = true;
    return core;
  }

  /** Ref count for diagnostics (test-only). */
  get debugRefCount(): number {
    return this.refCount;
  }

  /** Whether the core's shared shutdown has already run (refcount reached zero). */
  get isShutDown(): boolean {
    return this.closed;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Atomically increments the refcount if the core is still alive.
   * Returns false if the core has already shut down — caller must construct a new one.
   */
  tryAcquire(): boolean {
    if (this.closed || this.refCount <= 0) {
      return false;
    }
    this.refCount++;
    return true;
  }

  /**
   * Decrements the refcount. When it reaches zero, runs the real shutdown
   * exactly once. Over-release is a no-op — the guard prevents re-entry.
   */
  async release(): Promise<void> {
    if (this.refCount <= 0) return;
    this.refCount--;
    if (this.refCount === 0) {
      await this.shutdown();
    }
  }

  /**
   * Called by the factory after successfully inserting this core into the
   * owning map so Shutdown can remove itself from the map.
   */
  setOwningMap(map: Map<string, SharedFeatureflipCore>, key: string): void {
    this.owningMap = map;
    this.owningKey = key;
  }

  /**
   * Subscribe to flag-configuration updates. Returns an unsubscribe function.
   * Listeners live on the shared core, so they fire for updates regardless of
   * which handle triggered them; handles remove their own on close.
   */
  onUpdate(listener: FlagUpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  offUpdate(listener: FlagUpdateListener): void {
    this.updateListeners.delete(listener);
  }

  /**
   * Fire the registered update listeners. A throwing listener is isolated: it
   * neither breaks the data-source callback nor stops the remaining listeners.
   */
  private notifyUpdateListeners(keys: string[]): void {
    for (const listener of this.updateListeners) {
      try {
        listener([...keys]);
      } catch (err) {
        console.warn('[featureflip] flag update listener threw:', err);
      }
    }
  }

  /** Wait for the core to finish loading initial flag data. */
  async waitForInitialization(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    return this.initPromise;
  }

  /**
   * @param expected The `typeof` result the caller's typed accessor requires, or
   *   undefined for the generic/JSON accessors. Those take no runtime type — a
   *   TypeScript type parameter is erased — so there is nothing to check them
   *   against and they are left unchecked.
   */
  variationDetail<T>(
    key: string,
    context: EvaluationContext,
    defaultValue: T,
    expected?: ExpectedValueType,
  ): EvaluationDetail<T> {
    const flag = this.store.getFlag(key);
    if (!flag) {
      this.recordEvaluation(key, context, undefined);
      this.notifyInspectors(key, context, defaultValue, { reason: 'FlagNotFound' });
      return { value: defaultValue, reason: 'FlagNotFound' };
    }

    try {
      const allFlags = Object.fromEntries(
        this.store.getAllFlags().map((f) => [f.key, f]),
      );
      const result = evaluate(flag, context, {
        md5: (input) => this.platform.md5(input),
        getSegment: (segKey) => this.store.getSegment(segKey),
      }, allFlags);

      // Malformed config: the evaluator selected a variation key the flag does
      // not define (e.g. a fallthrough/rule naming a since-deleted variation).
      // Degrade to the caller's default and report Error, mirroring the engine's
      // ServeVariation + the C#/Java SDKs (#1989). A variation that genuinely
      // exists with a null value is NOT this case — hence the key lookup rather
      // than a `value === null` check, which cannot tell the two apart.
      const served = result.variationKey
        ? flag.variations.find((v) => v.key === result.variationKey)
        : undefined;
      let reason: EvaluationReason =
        result.variationKey && !served ? 'Error' : result.reason;

      let value = result.value !== undefined && result.value !== null
        ? (result.value as T)
        : defaultValue;

      // A typed accessor asked for a specific JSON type and the SERVED value is
      // not it. Degrade to the caller's default and report Error so the mismatch
      // is detectable, rather than handing back a string where the caller's code
      // expects a boolean (#2281). Checking `result.value` rather than `value`
      // matters: a variation whose value is genuinely null has already been
      // replaced by defaultValue above, and that substitute would pass any check.
      if (expected && typeof result.value !== expected) {
        value = defaultValue;
        reason = 'Error';
      }

      this.recordEvaluation(key, context, result.variationKey, result.prerequisiteKey);
      this.notifyInspectors(key, context, value, {
        variationKey: result.variationKey,
        reason,
        ruleId: result.ruleId,
        prerequisiteKey: result.prerequisiteKey,
      });

      return {
        value,
        variationKey: result.variationKey,
        reason,
        ruleId: result.ruleId,
        prerequisiteKey: result.prerequisiteKey,
      };
    } catch {
      this.recordEvaluation(key, context, undefined);
      this.notifyInspectors(key, context, defaultValue, { reason: 'Error' });
      return { value: defaultValue, reason: 'Error' };
    }
  }

  evaluateFlag<T>(
    key: string,
    context: EvaluationContext,
    defaultValue: T,
    expected?: ExpectedValueType,
  ): T {
    return this.variationDetail(key, context, defaultValue, expected).value;
  }

  track(
    eventKey: string,
    context: EvaluationContext,
    metadata?: Record<string, unknown>,
  ): void {
    const userId = resolveEventUserId(context);

    this.events.enqueue({
      type: 'Custom',
      flagKey: eventKey,
      userId,
      timestamp: new Date().toISOString(),
      // Omit an empty bag rather than sending `{}`, so an argument-less
      // track() puts the same bytes on the wire as every other SDK (#2359).
      metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  identify(context: EvaluationContext): void {
    const userId = resolveEventUserId(context);

    // Strip both the canonical field and its alias so the identity is promoted
    // to the top-level `userId` and not duplicated inside the metadata bag.
    const { user_id: _userId, userId: _userIdAlias, ...metadata } = context;

    this.events.enqueue({
      type: 'Identify',
      flagKey: '$identify',
      userId,
      timestamp: new Date().toISOString(),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  async flush(): Promise<void> {
    await this.events.flush();
  }

  /**
   * Runs the real shutdown exactly once. Closes the SSE connection, clears
   * timers, flushes events, and removes the entry from the owning map.
   * Safe to call more than once — subsequent calls are no-ops.
   */
  private async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.owningMap && this.owningKey) {
      // Only remove if we're still the mapped instance — defensive against
      // a racing factory call that already replaced us with a new core.
      if (this.owningMap.get(this.owningKey) === this) {
        this.owningMap.delete(this.owningKey);
      }
    }

    this.eventSource?.close();
    this.eventSource = null;
    if (this.streamRetryTimer) {
      clearTimeout(this.streamRetryTimer);
      this.streamRetryTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.events.close();
  }

  // --- Private ---

  private async initialize(): Promise<void> {
    // Best-effort initial fetch, bounded by initTimeout via an AbortController so
    // the underlying request is actually cancelled (socket released) on timeout —
    // not left running as a detached Promise the way a sibling `Promise.race`
    // reject would leave it. On failure OR timeout we still start the data source
    // below, so a cold start during an outage self-heals — serving caller
    // defaults meanwhile. initialize() never rejects. (Mirrors the browser core.)
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.initTimeout,
    );

    try {
      await this.fetchFlags(controller.signal);
    } catch (err) {
      // Initial fetch failed, timed out, or was aborted — serve caller defaults;
      // the data source started below keeps trying and self-heals when the
      // eval-api returns. A malformed payload will NOT self-heal, so say so.
      this.warnIfMalformed(err, 'initial snapshot');
    } finally {
      clearTimeout(timer);
    }

    if (this.closed) return;
    this.initialized = true;
    this.events.start();
    await this.startDataSource();
  }

  private async fetchFlags(signal?: AbortSignal): Promise<void> {
    const response = await this.platform.fetch(
      `${this.config.baseUrl}/v1/sdk/flags`,
      { headers: this.headers(), signal },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch flags: ${response.status}`);
    }

    const data = (await response.json()) as GetFlagsResponse;
    // Validate BEFORE touching the store: a contract violation must leave the
    // previous config serving rather than replace it with a broken one (#2315).
    validateSnapshot(data);
    this.applySnapshot(data);
  }

  /**
   * Apply a validated snapshot, minus any entity carrying an enum value this build
   * cannot evaluate (#2402).
   *
   * Split from the two call sites rather than inlined at each so polling and streaming
   * cannot drift — treating the two transports as one payload shape is exactly what
   * #2279 taught, and a guard applied to only one of them is the same bug with a
   * narrower trigger.
   */
  private applySnapshot(data: GetFlagsResponse): void {
    const { flags, segments, dropped } = dropUnevaluableEntities(data);
    for (const entity of dropped) {
      console.warn(
        `[featureflip] dropping ${entity.kind} "${entity.key}": ${entity.reason}. ` +
          'This SDK version may be older than the flag configuration; the rest of the ' +
          'configuration was applied.',
      );
    }
    this.store.init(flags, segments, data.version);
  }

  private async startDataSource(): Promise<void> {
    if (this.closed) return;

    if (this.config.streaming) {
      await this.startStreaming();
    } else {
      this.startPolling();
    }
  }

  private async startStreaming(): Promise<void> {
    if (this.closed) return;

    // Browser EventSource doesn't support custom headers, so the SDK key
    // must be passed as a query parameter. Node.js eventsource supports
    // headers, so we avoid leaking the key in the URL (it ends up in
    // server access logs, CDN logs, and proxy logs).
    const streamUrl = this.platform.sseSupportsHeaders
      ? `${this.config.baseUrl}/v1/sdk/stream`
      : `${this.config.baseUrl}/v1/sdk/stream?authorization=${encodeURIComponent(this.config.sdkKey)}`;

    // createEventSource may be async — the Node platform dynamic-imports its
    // ESM-only `eventsource` dependency (see platform/node.ts). Two consequences
    // are handled here rather than by the caller:
    //
    // 1. It can REJECT (dependency missing, or its module body throws). That must
    //    not escape: startStreaming is awaited by initialize(), whose contract —
    //    and waitForInitialization()'s — is that it never rejects. Fall back to
    //    polling so a broken stream degrades instead of taking the client down.
    // 2. close() can land while the import is still in flight, in which case
    //    shutdown() has already run and will never see this instance. Close the
    //    resolved one here or it leaks an open SSE socket for the process's life.
    let es: EventSourceLike;
    try {
      es = await this.platform.createEventSource(streamUrl, this.headers());
    } catch (err) {
      console.warn(
        '[featureflip] could not start the SSE stream, falling back to polling:',
        err,
      );
      this.startPolling();
      return;
    }

    if (this.closed) {
      es.close();
      return;
    }

    this.eventSource = es;

    // flag.created and flag.updated — fetch the single flag
    for (const eventType of ['flag.created', 'flag.updated']) {
      es.addEventListener(
        eventType,
        (event: { data: string }) => {
          try {
            const update = JSON.parse(event.data) as StreamFlagUpdatedEvent;
            if (update.key) {
              void this.fetchSingleFlag(update.key);
            }
          } catch {
            // Ignore parse errors
          }
        },
      );
    }

    // flag.deleted — remove from store
    es.addEventListener(
      'flag.deleted',
      (event: { data: string }) => {
        try {
          const update = JSON.parse(event.data) as StreamFlagUpdatedEvent;
          if (update.key) {
            this.store.delete(update.key);
          }
        } catch {
          // Ignore parse errors
        }
      },
    );

    // segment.updated — refetch all flags
    es.addEventListener(
      'segment.updated',
      () => {
        void this.fetchFlags().catch((err: unknown) => {
          this.warnIfMalformed(err, 'segment.updated refetch');
        });
      },
    );

    // sync — full config snapshot the server sends on (re)connect. Replace the
    // whole store so flags changed or deleted during a disconnect are re-synced.
    es.addEventListener(
      'sync',
      (event: { data: string }) => {
        try {
          const data = JSON.parse(event.data) as GetFlagsResponse;
          validateSnapshot(data);
          this.applySnapshot(data);
        } catch (err) {
          this.warnIfMalformed(err, 'sync snapshot');
        }
      },
    );

    es.addEventListener('open', () => {
      this.streamRetryCount = 0;
    });

    es.addEventListener('error', () => {
      // Ignore an error from a stream we have already replaced or torn down.
      // Without this, a late second 'error' from a closed instance would close
      // the CURRENT one and schedule a duplicate retry — reachable now that
      // there is an await between an error firing and its successor existing.
      if (this.eventSource !== es) return;

      es.close();
      this.eventSource = null;

      if (this.closed) return;

      if (this.streamRetryCount >= this.config.maxStreamRetries) {
        console.warn(
          `[featureflip] SSE connection failed after ${this.config.maxStreamRetries} retries, falling back to polling`,
        );
        this.startPolling();
        return;
      }

      const delay = Math.min(1000 * Math.pow(2, this.streamRetryCount), 30_000);
      this.streamRetryCount++;
      this.streamRetryTimer = setTimeout(() => {
        this.streamRetryTimer = null;
        void this.startStreaming();
      }, delay);
    });
  }

  private startPolling(): void {
    // Reachable from both the max-retries fallback and the createEventSource
    // failure path; a second call must not leak a duplicate interval.
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      void this.fetchFlags().catch((err: unknown) => {
        // Network failures stay silent by design; a contract violation does not.
        this.warnIfMalformed(err, 'polled snapshot');
      });
    }, this.config.pollInterval);
  }

  /**
   * Emit a diagnostic for a wire-contract violation, and only for that.
   *
   * Network and JSON-syntax failures are deliberately left silent: they self-heal on
   * the next poll or reconnect, and warning on each would flood the console of any
   * client that is briefly offline. A MalformedPayloadError means the server and SDK
   * disagree about the shape of the data — that never self-heals and must be visible
   * ("never swallow silently", packages/CLAUDE.md).
   */
  private warnIfMalformed(err: unknown, context: string): void {
    if (err instanceof MalformedPayloadError) {
      console.warn(`[featureflip] discarding malformed ${context}:`, err.message);
    }
  }

  private async fetchSingleFlag(key: string): Promise<void> {
    try {
      const response = await this.platform.fetch(
        `${this.config.baseUrl}/v1/sdk/flags/${encodeURIComponent(key)}`,
        { headers: this.headers() },
      );
      if (response.ok) {
        const flag = (await response.json()) as FlagDto;
        validateFlag(flag);
        // An unevaluable enum drops the flag rather than upserting it (#2402). For a
        // delta whose whole scope is one flag that means leaving the store's previous
        // copy in place: replacing it with one this build would mis-evaluate is the
        // outcome the drop exists to prevent, and `FlagNotFound` is the honest answer
        // if there was no previous copy.
        const unevaluable = unevaluableFlagReason(flag);
        if (unevaluable) {
          console.warn(
            `[featureflip] dropping flag delta for "${key}": ${unevaluable}. ` +
              'This SDK version may be older than the flag configuration.',
          );
          return;
        }
        this.store.upsert(flag);
      }
    } catch (err) {
      this.warnIfMalformed(err, `flag delta for "${key}"`);
    }
  }

  /**
   * Fire the registered evaluation inspectors. Called once per variation call
   * on every exit path of variationDetail. A throwing inspector is isolated:
   * it neither breaks evaluation nor stops the remaining inspectors.
   */
  private notifyInspectors(
    flagKey: string,
    context: EvaluationContext,
    value: unknown,
    detail: {
      variationKey?: string;
      reason: EvaluationReason;
      ruleId?: string;
      prerequisiteKey?: string;
    },
  ): void {
    if (this.inspectors.length === 0) return;

    const event: EvaluationEvent = {
      flagKey,
      context: { ...context },
      value,
      variationKey: detail.variationKey,
      reason: detail.reason,
      ruleId: detail.ruleId,
      prerequisiteKey: detail.prerequisiteKey,
      timestamp: new Date().toISOString(),
    };

    for (const inspector of this.inspectors) {
      try {
        inspector(event);
      } catch (err) {
        console.warn('[featureflip] evaluation inspector threw:', err);
      }
    }
  }

  private recordEvaluation(
    key: string,
    context: EvaluationContext,
    variationKey: string | undefined,
    prerequisiteKey?: string,
  ): void {
    const userId = resolveEventUserId(context);

    // `prerequisiteKey` is undefined except on the PrerequisiteFailed path;
    // JSON.stringify drops undefined fields, so it's absent (not null) on the
    // wire — matching the backend's WhenWritingNull serialization.
    this.events.enqueue({
      type: 'Evaluation',
      flagKey: key,
      userId,
      variation: variationKey,
      timestamp: new Date().toISOString(),
      prerequisiteKey,
    });
  }

  private headers(): Record<string, string> {
    return {
      Authorization: this.config.sdkKey,
      'Content-Type': 'application/json',
      ...this.platform.extraHeaders,
    };
  }
}

/**
 * Structural comparison of resolved configs. Used to warn when a later
 * `get()` call passes options that meaningfully differ from the cached
 * instance's options. sdkKey is excluded (it's the cache key itself).
 */
export function resolvedConfigsEqual(a: ResolvedConfig, b: ResolvedConfig): boolean {
  return (
    a.baseUrl === b.baseUrl &&
    a.streaming === b.streaming &&
    a.pollInterval === b.pollInterval &&
    a.flushInterval === b.flushInterval &&
    a.flushBatchSize === b.flushBatchSize &&
    a.initTimeout === b.initTimeout &&
    a.maxStreamRetries === b.maxStreamRetries
  );
}
