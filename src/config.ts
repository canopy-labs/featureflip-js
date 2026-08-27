import type { EvaluationInspector } from './core/types.js';

export interface FeatureflipConfig {
  sdkKey: string;
  baseUrl: string;
  streaming?: boolean;
  pollInterval?: number;
  flushInterval?: number;
  flushBatchSize?: number;
  initTimeout?: number;
  maxStreamRetries?: number;
  /**
   * In-process observers fired on every flag evaluation. Honored on the first
   * `get()` per SDK key (singleton-by-construction); not part of the resolved
   * config or the config-equality check.
   */
  inspectors?: EvaluationInspector[];
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

  const resolved: ResolvedConfig = {
    sdkKey: config.sdkKey,
    baseUrl,
    streaming: config.streaming ?? DEFAULTS.streaming,
    pollInterval: config.pollInterval ?? DEFAULTS.pollInterval,
    flushInterval: config.flushInterval ?? DEFAULTS.flushInterval,
    flushBatchSize: config.flushBatchSize ?? DEFAULTS.flushBatchSize,
    initTimeout: config.initTimeout ?? DEFAULTS.initTimeout,
    maxStreamRetries: config.maxStreamRetries ?? DEFAULTS.maxStreamRetries,
  };

  // Validate numeric config. Invalid values wedge the runtime rather than
  // failing obviously: a flushBatchSize below 1 makes the event flush loop
  // splice nothing and hot-spin forever, and a non-positive interval turns a
  // setInterval into a runaway timer. Reject loudly at construction time,
  // mirroring the sdkKey/baseUrl checks above.
  requirePositive('flushInterval', resolved.flushInterval);
  requirePositive('pollInterval', resolved.pollInterval);
  requirePositive('initTimeout', resolved.initTimeout);
  if (!Number.isFinite(resolved.flushBatchSize) || resolved.flushBatchSize < 1) {
    throw new Error('flushBatchSize must be a number >= 1');
  }
  if (
    !Number.isFinite(resolved.maxStreamRetries) ||
    resolved.maxStreamRetries < 0
  ) {
    throw new Error('maxStreamRetries must be a number >= 0');
  }

  return resolved;
}

function requirePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
}
