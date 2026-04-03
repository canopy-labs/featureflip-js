import type { FeatureflipConfig, ResolvedConfig } from './config.js';
import { resolveConfig } from './config.js';
import { FlagStore } from './core/store.js';
import { evaluate } from './core/evaluator.js';
import { EventProcessor } from './core/events.js';
import type {
  EvaluationContext,
  EvaluationDetail,
  FlagDto,
  GetFlagsResponse,
  SdkEventDto,
  StreamFlagUpdatedEvent,
} from './core/types.js';
import type { EventSourceLike, Platform } from './platform/types.js';

export class FeatureflipClient {
  private readonly config: ResolvedConfig;
  private readonly store: FlagStore;
  private readonly events: EventProcessor;
  private readonly platform: Platform;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private eventSource: EventSourceLike | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private streamRetryCount = 0;
  private streamRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: FeatureflipConfig, platform: Platform) {
    this.config = resolveConfig(config);
    this.store = new FlagStore();
    this.platform = platform;

    this.events = new EventProcessor(
      {
        sendEvents: async (request) => {
          await this.platform.fetch(
            `${this.config.baseUrl}/v1/sdk/events`,
            {
              method: 'POST',
              headers: this.headers(),
              body: JSON.stringify(request),
            },
          );
        },
      },
      this.config.flushInterval,
      this.config.flushBatchSize,
    );
  }

  /** Whether the client has successfully loaded initial flag data. */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Wait for the client to finish initialization.
   * Rejects after initTimeout if initial flag fetch fails.
   */
  async waitForInitialization(): Promise<void> {
    if (this.initialized) return;

    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    return this.initPromise;
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
    return this.evaluateFlag(key, context, defaultValue);
  }

  /**
   * Evaluate a string flag.
   */
  stringVariation(
    key: string,
    context: EvaluationContext,
    defaultValue: string,
  ): string {
    return this.evaluateFlag(key, context, defaultValue);
  }

  /**
   * Evaluate a number flag.
   */
  numberVariation(
    key: string,
    context: EvaluationContext,
    defaultValue: number,
  ): number {
    return this.evaluateFlag(key, context, defaultValue);
  }

  /**
   * Evaluate a JSON flag.
   */
  jsonVariation<T>(
    key: string,
    context: EvaluationContext,
    defaultValue: T,
  ): T {
    return this.evaluateFlag(key, context, defaultValue);
  }

  /**
   * Evaluate a flag and return the full detail including reason.
   */
  variationDetail<T>(
    key: string,
    context: EvaluationContext,
    defaultValue: T,
  ): EvaluationDetail<T> {
    const flag = this.store.getFlag(key);
    if (!flag) {
      this.recordEvaluation(key, context, undefined);
      return { value: defaultValue, reason: 'FlagNotFound' };
    }

    try {
      const result = evaluate(flag, context, {
        md5: (input) => this.platform.md5(input),
        getSegment: (segKey) => this.store.getSegment(segKey),
      });

      const value = result.value !== undefined && result.value !== null
        ? (result.value as T)
        : defaultValue;
      this.recordEvaluation(key, context, result.variationKey);

      return {
        value,
        reason: result.reason,
        ruleId: result.ruleId,
      };
    } catch {
      this.recordEvaluation(key, context, undefined);
      return { value: defaultValue, reason: 'Error' };
    }
  }

  /**
   * Track a custom event.
   */
  track(
    eventKey: string,
    context: EvaluationContext,
    metadata?: Record<string, unknown>,
  ): void {
    const userId =
      context.user_id != null ? String(context.user_id) : undefined;

    this.events.enqueue({
      type: 'Custom',
      flagKey: eventKey,
      userId,
      timestamp: new Date().toISOString(),
      metadata,
    });
  }

  /**
   * Send an identify event for the given context.
   */
  identify(context: EvaluationContext): void {
    const userId =
      context.user_id != null ? String(context.user_id) : undefined;

    const { user_id: _, ...metadata } = context;

    this.events.enqueue({
      type: 'Identify',
      flagKey: '$identify',
      userId,
      timestamp: new Date().toISOString(),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  /**
   * Flush any pending events immediately.
   */
  async flush(): Promise<void> {
    await this.events.flush();
  }

  /**
   * Close the client, flushing pending events and stopping all connections.
   */
  async close(): Promise<void> {
    this.closed = true;
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

  /**
   * Create a test client with hardcoded flag values. No network calls.
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

    const noopPlatform: Platform = {
      md5: () => new Uint8Array(16),
      createEventSource: () => ({
        addEventListener: () => {},
        close: () => {},
        readyState: 2,
      }),
      fetch: async () => new Response(),
    };

    const client = new FeatureflipClient(
      { sdkKey: 'test-key', baseUrl: 'http://localhost' },
      noopPlatform,
    );

    client.store.init(flagDtos, [], 1);
    client.initialized = true;
    return client;
  }

  // --- Private ---

  private evaluateFlag<T>(
    key: string,
    context: EvaluationContext,
    defaultValue: T,
  ): T {
    const detail = this.variationDetail(key, context, defaultValue);
    return detail.value;
  }

  private async initialize(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Initialization timed out')),
        this.config.initTimeout,
      );
    });

    const initPromise = (async () => {
      await this.fetchFlags();
      this.initialized = true;
      this.events.start();
      this.startDataSource();
    })();

    try {
      await Promise.race([initPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchFlags(): Promise<void> {
    const response = await this.platform.fetch(
      `${this.config.baseUrl}/v1/sdk/flags`,
      { headers: this.headers() },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch flags: ${response.status}`);
    }

    const data = (await response.json()) as GetFlagsResponse;
    this.store.init(data.flags, data.segments, data.version);
  }

  private startDataSource(): void {
    if (this.closed) return;

    if (this.config.streaming) {
      this.startStreaming();
    } else {
      this.startPolling();
    }
  }

  private startStreaming(): void {
    if (this.closed) return;

    // Browser EventSource doesn't support custom headers, so the SDK key
    // must be passed as a query parameter. Node.js eventsource supports
    // headers, so we avoid leaking the key in the URL (it ends up in
    // server access logs, CDN logs, and proxy logs).
    const streamUrl = this.platform.sseSupportsHeaders
      ? `${this.config.baseUrl}/v1/sdk/stream`
      : `${this.config.baseUrl}/v1/sdk/stream?authorization=${encodeURIComponent(this.config.sdkKey)}`;
    this.eventSource = this.platform.createEventSource(streamUrl, this.headers());

    // flag.created and flag.updated — fetch the single flag
    for (const eventType of ['flag.created', 'flag.updated']) {
      this.eventSource.addEventListener(
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
    this.eventSource.addEventListener(
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
    this.eventSource.addEventListener(
      'segment.updated',
      () => {
        void this.fetchFlags().catch(() => {
          // Refetch failures are silent
        });
      },
    );

    this.eventSource.addEventListener('open', () => {
      this.streamRetryCount = 0;
    });

    this.eventSource.addEventListener('error', () => {
      this.eventSource?.close();
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
        this.startStreaming();
      }, delay);
    });
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      void this.fetchFlags().catch(() => {
        // Polling failures are silent
      });
    }, this.config.pollInterval);
  }

  private async fetchSingleFlag(key: string): Promise<void> {
    try {
      const response = await this.platform.fetch(
        `${this.config.baseUrl}/v1/sdk/flags/${encodeURIComponent(key)}`,
        { headers: this.headers() },
      );
      if (response.ok) {
        const flag = (await response.json()) as FlagDto;
        this.store.upsert(flag);
      }
    } catch {
      // Flag fetch failures are silent
    }
  }

  private recordEvaluation(
    key: string,
    context: EvaluationContext,
    variationKey: string | undefined,
  ): void {
    const userId =
      context.user_id != null ? String(context.user_id) : undefined;

    this.events.enqueue({
      type: 'Evaluation',
      flagKey: key,
      userId,
      variation: variationKey,
      timestamp: new Date().toISOString(),
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
