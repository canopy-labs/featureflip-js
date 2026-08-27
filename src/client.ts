import type { FeatureflipConfig } from './config.js';
import { resolveConfig } from './config.js';
import { SharedFeatureflipCore, resolvedConfigsEqual } from './core/shared-core.js';
import type {
  EvaluationContext,
  EvaluationDetail,
  FeatureflipEvent,
  FlagDto,
  FlagUpdateListener,
} from './core/types.js';
import type { Platform } from './platform/types.js';

/**
 * Process-wide cache of shared cores keyed by SDK key. JS is single-threaded
 * so a plain Map is sufficient — no locking needed for get-or-create.
 */
const liveCores = new Map<string, SharedFeatureflipCore>();

/**
 * The main client for evaluating feature flags. Obtain instances via the
 * static factory {@link FeatureflipClient.get}; direct instantiation is not
 * supported. Multiple `get` calls with the same SDK key return handles
 * sharing one underlying shared core (refcounted); the shared core shuts
 * down when the last handle is closed.
 */
export class FeatureflipClient {
  private readonly core: SharedFeatureflipCore;
  private disposed = false;

  /**
   * Unsubscribe callbacks for listeners registered through this handle, so
   * closing one handle doesn't leave its listeners firing off a shared core
   * that other handles keep alive.
   */
  private readonly subscriptions = new Map<FlagUpdateListener, () => void>();

  /**
   * Private constructor — reachable only through the static factory and
   * test helpers. Direct callers see a TypeScript error; runtime JS users
   * who bypass the type system still work, but this is intentionally
   * undocumented.
   */
  private constructor(core: SharedFeatureflipCore) {
    this.core = core;
  }

  /**
   * Returns a client for the given SDK key. The first call with a given key
   * constructs and initializes a shared core; subsequent calls with the same
   * key return a new handle pointing at the cached core. When the last handle
   * for a key is closed, the core shuts down and is removed from the cache.
   *
   * The `platform` argument is honored only on the first call for a given SDK
   * key. Subsequent callers pass a platform that is silently ignored (since
   * the shared core already has one).
   */
  static get(config: FeatureflipConfig, platform: Platform): FeatureflipClient {
    if (!config.sdkKey) {
      throw new Error('sdkKey is required');
    }
    const sdkKey = config.sdkKey;

    // Retry loop handles the race where a cached core is found but has already
    // begun shutting down (refcount hit 0 between lookup and tryAcquire).
    // In single-threaded JS this loop should rarely iterate more than once,
    // but the cleanup-and-retry pattern keeps semantics consistent with the
    // multi-threaded reference implementations (C#, Java).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existing = liveCores.get(sdkKey);
      if (existing) {
        if (existing.tryAcquire()) {
          const resolved = resolveConfig(config);
          if (!resolvedConfigsEqual(existing.config, resolved)) {
            console.warn(
              '[featureflip] FeatureflipClient.get called with different options for ' +
                'an SDK key already in use. The cached instance\'s options are preserved; ' +
                'the passed options are ignored.',
            );
          }
          return new FeatureflipClient(existing);
        }
        // Stale entry — core shut down between lookup and acquire. Drop it.
        if (liveCores.get(sdkKey) === existing) {
          liveCores.delete(sdkKey);
        }
        continue;
      }

      const newCore = new SharedFeatureflipCore(config, platform);
      liveCores.set(sdkKey, newCore);
      newCore.setOwningMap(liveCores, sdkKey);
      return new FeatureflipClient(newCore);
    }
  }

  /** Whether the client has successfully loaded initial flag data. */
  get isInitialized(): boolean {
    return !this.disposed && this.core.isInitialized;
  }

  /**
   * Wait for the client to finish initialization.
   *
   * Resolves once the initial flag fetch completes — or, if that fetch fails or
   * exceeds `initTimeout`, resolves in a degraded state that serves caller
   * defaults while the data source reconnects in the background. Never rejects.
   */
  async waitForInitialization(): Promise<void> {
    return this.core.waitForInitialization();
  }

  /**
   * Evaluate a boolean flag.
   * Returns defaultValue if flag not found or evaluation fails.
   */
  boolVariation(
    key: string,
    context: EvaluationContext,
    defaultValue: boolean,
  ): boolean {
    if (this.disposed) return defaultValue;
    return this.core.evaluateFlag(key, context, defaultValue, 'boolean');
  }

  /** Evaluate a string flag. */
  stringVariation(
    key: string,
    context: EvaluationContext,
    defaultValue: string,
  ): string {
    if (this.disposed) return defaultValue;
    return this.core.evaluateFlag(key, context, defaultValue, 'string');
  }

  /** Evaluate a number flag. */
  numberVariation(
    key: string,
    context: EvaluationContext,
    defaultValue: number,
  ): number {
    if (this.disposed) return defaultValue;
    return this.core.evaluateFlag(key, context, defaultValue, 'number');
  }

  /** Evaluate a JSON flag. */
  jsonVariation<T>(
    key: string,
    context: EvaluationContext,
    defaultValue: T,
  ): T {
    if (this.disposed) return defaultValue;
    return this.core.evaluateFlag(key, context, defaultValue);
  }

  /** Evaluate a flag and return the full detail including reason. */
  variationDetail<T>(
    key: string,
    context: EvaluationContext,
    defaultValue: T,
  ): EvaluationDetail<T> {
    // A closed handle serves the caller's default (#2310). close() releases the
    // core — shutting down SSE, clearing timers, flushing events — but the
    // in-memory store stays readable, so without this guard the handle would
    // keep serving a frozen snapshot that can never update again.
    if (this.disposed) return { value: defaultValue, reason: 'Error' };
    return this.core.variationDetail(key, context, defaultValue);
  }

  /**
   * Subscribe to flag-configuration updates.
   *
   * The listener receives the keys of the flags affected by each update —
   * added, removed, redefined, whose referenced segment changed, or which
   * depend (transitively) on a changed flag via a prerequisite — batched into
   * one call per update. It does not fire for the initial flag load; use
   * {@link waitForInitialization} for that.
   *
   * Returns an unsubscribe function. Listeners are also dropped automatically
   * when this handle is closed.
   */
  on(event: FeatureflipEvent, listener: FlagUpdateListener): () => void {
    // Re-registering the same listener on the same handle is a no-op, matching
    // addEventListener semantics.
    const existing = this.subscriptions.get(listener);
    if (existing) return existing;

    // Register a distinct wrapper per handle: the core dedupes by identity, so
    // two handles sharing a core and passing the same function would otherwise
    // collapse into one subscription that either handle's close could revoke.
    const unsubscribeCore = this.core.onUpdate((keys) => listener(keys));
    const unsubscribe = () => {
      unsubscribeCore();
      this.subscriptions.delete(listener);
    };
    this.subscriptions.set(listener, unsubscribe);
    return unsubscribe;
  }

  /** Remove a listener previously registered with {@link on}. */
  off(event: FeatureflipEvent, listener: FlagUpdateListener): void {
    this.subscriptions.get(listener)?.();
  }

  /** Track a custom event. */
  track(
    eventKey: string,
    context: EvaluationContext,
    metadata?: Record<string, unknown>,
  ): void {
    if (this.disposed) return;
    this.core.track(eventKey, context, metadata);
  }

  /** Send an identify event for the given context. */
  identify(context: EvaluationContext): void {
    if (this.disposed) return;
    this.core.identify(context);
  }

  /** Flush any pending events immediately. */
  async flush(): Promise<void> {
    return this.core.flush();
  }

  /**
   * Close this handle. If this is the last handle for the shared core, the
   * core is shut down (connections closed, events flushed, timers cleared).
   * Double-close on the same handle is idempotent and does not double-decrement.
   */
  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of [...this.subscriptions.values()]) {
      unsubscribe();
    }
    await this.core.release();
  }

  /**
   * Create a test client with hardcoded flag values. No network calls, no
   * cache entry. Each call returns an independent client backed by its own
   * shared core.
   */
  static forTesting(
    flags: Record<string, unknown>,
  ): FeatureflipClient {
    const flagDtos: FlagDto[] = Object.entries(flags).map(([key, value]) => ({
      key,
      version: 1,
      type: typeof value === 'boolean'
        ? 'Boolean'
        : typeof value === 'number'
          ? 'Number'
          : typeof value === 'string'
            ? 'String'
            : 'Json',
      enabled: true,
      variations: [{ key: 'default', value }],
      rules: [],
      fallthrough: { type: 'Fixed', variation: 'default' },
      offVariation: 'default',
    }));

    const core = SharedFeatureflipCore.createForTesting(flagDtos);
    return new FeatureflipClient(core);
  }

  /**
   * Current number of live shared cores in the factory cache. Diagnostic only.
   * @internal
   */
  static get debugLiveCoreCount(): number {
    return liveCores.size;
  }

  /**
   * Returns the shared core's current refcount for the given SDK key, or 0 if
   * no core is cached for that key. Diagnostic only.
   * @internal
   */
  static debugRefCount(sdkKey: string): number {
    return liveCores.get(sdkKey)?.debugRefCount ?? 0;
  }

  /**
   * Reset the factory cache. For test isolation only — forces shutdown of
   * each currently-cached core. Handles that callers still hold will be
   * invalidated (their subsequent operations still work on the core's
   * in-memory state but background tasks are stopped).
   * @internal
   */
  static async resetForTesting(): Promise<void> {
    const cores = [...liveCores.values()];
    liveCores.clear();
    await Promise.all(
      cores.map(async (core) => {
        // Force-drop the refcount regardless of how many handles are live.
        while (core.debugRefCount > 0 && !core.isShutDown) {
          await core.release();
        }
      }),
    );
  }
}
