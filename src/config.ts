export interface FeatureflipConfig {
  sdkKey: string;
  baseUrl: string;
  streaming?: boolean;
  pollInterval?: number;
  flushInterval?: number;
  flushBatchSize?: number;
  initTimeout?: number;
  maxStreamRetries?: number;
}

export interface ResolvedConfig {
  sdkKey: string;
  baseUrl: string;
  streaming: boolean;
  pollInterval: number;
  flushInterval: number;
  flushBatchSize: number;
  initTimeout: number;
  maxStreamRetries: number;
}

const DEFAULTS = {
  streaming: true,
  pollInterval: 30_000,
  flushInterval: 30_000,
  flushBatchSize: 100,
  initTimeout: 10_000,
  maxStreamRetries: 5,
} as const;

export function resolveConfig(config: FeatureflipConfig): ResolvedConfig {
  if (!config.sdkKey) {
    throw new Error('sdkKey is required');
  }
  if (!config.baseUrl) {
    throw new Error('baseUrl is required');
  }

  const baseUrl = config.baseUrl.replace(/\/+$/, '');

  return {
    sdkKey: config.sdkKey,
    baseUrl,
    streaming: config.streaming ?? DEFAULTS.streaming,
    pollInterval: config.pollInterval ?? DEFAULTS.pollInterval,
    flushInterval: config.flushInterval ?? DEFAULTS.flushInterval,
    flushBatchSize: config.flushBatchSize ?? DEFAULTS.flushBatchSize,
    initTimeout: config.initTimeout ?? DEFAULTS.initTimeout,
    maxStreamRetries: config.maxStreamRetries ?? DEFAULTS.maxStreamRetries,
  };
}
