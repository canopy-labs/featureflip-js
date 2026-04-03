export declare function createBrowserPlatform(): Platform;

export declare type EvaluationContext = Record<string, unknown>;

export declare interface EvaluationDetail<T = unknown> {
    value: T;
    variationKey?: string;
    reason: EvaluationReason;
    ruleId?: string;
}

export declare type EvaluationReason = 'RuleMatch' | 'Fallthrough' | 'FlagDisabled' | 'FlagNotFound' | 'Error';

declare interface EventSourceLike {
    addEventListener(type: string, listener: (event: {
        data: string;
    }) => void): void;
    close(): void;
    readonly readyState: number;
}

export declare class FeatureflipClient {
    private readonly config;
    private readonly store;
    private readonly events;
    private readonly platform;
    private initialized;
    private initPromise;
    private eventSource;
    private pollTimer;
    private closed;
    private streamRetryCount;
    private streamRetryTimer;
    constructor(config: FeatureflipConfig, platform: Platform);
    /** Whether the client has successfully loaded initial flag data. */
    get isInitialized(): boolean;
    /**
     * Wait for the client to finish initialization.
     * Rejects after initTimeout if initial flag fetch fails.
     */
    waitForInitialization(): Promise<void>;
    /**
     * Evaluate a boolean flag.
     * Returns defaultValue if flag not found or evaluation fails.
     */
    boolVariation(key: string, context: EvaluationContext, defaultValue: boolean): boolean;
    /**
     * Evaluate a string flag.
     */
    stringVariation(key: string, context: EvaluationContext, defaultValue: string): string;
    /**
     * Evaluate a number flag.
     */
    numberVariation(key: string, context: EvaluationContext, defaultValue: number): number;
    /**
     * Evaluate a JSON flag.
     */
    jsonVariation<T>(key: string, context: EvaluationContext, defaultValue: T): T;
    /**
     * Evaluate a flag and return the full detail including reason.
     */
    variationDetail<T>(key: string, context: EvaluationContext, defaultValue: T): EvaluationDetail<T>;
    /**
     * Track a custom event.
     */
    track(eventKey: string, context: EvaluationContext, metadata?: Record<string, unknown>): void;
    /**
     * Send an identify event for the given context.
     */
    identify(context: EvaluationContext): void;
    /**
     * Flush any pending events immediately.
     */
    flush(): Promise<void>;
    /**
     * Close the client, flushing pending events and stopping all connections.
     */
    close(): Promise<void>;
    /**
     * Create a test client with hardcoded flag values. No network calls.
     */
    static forTesting(flags: Record<string, unknown>): FeatureflipClient;
    private evaluateFlag;
    private initialize;
    private fetchFlags;
    private startDataSource;
    private startStreaming;
    private startPolling;
    private fetchSingleFlag;
    private recordEvaluation;
    private headers;
}

export declare interface FeatureflipConfig {
    sdkKey: string;
    baseUrl: string;
    streaming?: boolean;
    pollInterval?: number;
    flushInterval?: number;
    flushBatchSize?: number;
    initTimeout?: number;
    maxStreamRetries?: number;
}

export declare type FlagType = 'Boolean' | 'String' | 'Number' | 'Json';

export declare interface Platform {
    md5(input: string): Uint8Array;
    createEventSource(url: string, headers: Record<string, string>): EventSourceLike;
    fetch(url: string, init?: RequestInit): Promise<Response>;
    /** Extra headers the platform can inject (e.g. User-Agent on Node). */
    readonly extraHeaders?: Record<string, string>;
    /** Whether the platform's EventSource implementation supports custom headers. */
    readonly sseSupportsHeaders?: boolean;
}

export { }
