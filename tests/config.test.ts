import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../src/config.js';

const BASE = { sdkKey: 'k', baseUrl: 'http://localhost:5000' };

describe('resolveConfig', () => {
  it('applies defaults for a minimal valid config', () => {
    const resolved = resolveConfig({ ...BASE });
    expect(resolved.flushBatchSize).toBe(100);
    expect(resolved.flushInterval).toBe(30_000);
    expect(resolved.pollInterval).toBe(30_000);
    expect(resolved.initTimeout).toBe(10_000);
    expect(resolved.maxStreamRetries).toBe(5);
  });

  it('throws when flushBatchSize is 0', () => {
    expect(() => resolveConfig({ ...BASE, flushBatchSize: 0 })).toThrow(
      /flushBatchSize/,
    );
  });

  it('throws when flushBatchSize is negative', () => {
    expect(() => resolveConfig({ ...BASE, flushBatchSize: -5 })).toThrow(
      /flushBatchSize/,
    );
  });

  it('throws when flushBatchSize is a fraction below 1 (splice would drain nothing)', () => {
    expect(() => resolveConfig({ ...BASE, flushBatchSize: 0.5 })).toThrow(
      /flushBatchSize/,
    );
  });

  it('throws when flushBatchSize is not finite', () => {
    expect(() => resolveConfig({ ...BASE, flushBatchSize: NaN })).toThrow(
      /flushBatchSize/,
    );
  });

  it('accepts flushBatchSize of exactly 1', () => {
    expect(resolveConfig({ ...BASE, flushBatchSize: 1 }).flushBatchSize).toBe(1);
  });

  it('throws when flushInterval is not positive', () => {
    expect(() => resolveConfig({ ...BASE, flushInterval: 0 })).toThrow(
      /flushInterval/,
    );
  });

  it('throws when pollInterval is not positive', () => {
    expect(() => resolveConfig({ ...BASE, pollInterval: -1 })).toThrow(
      /pollInterval/,
    );
  });

  it('throws when initTimeout is not positive', () => {
    expect(() => resolveConfig({ ...BASE, initTimeout: 0 })).toThrow(
      /initTimeout/,
    );
  });

  it('throws when maxStreamRetries is negative', () => {
    expect(() => resolveConfig({ ...BASE, maxStreamRetries: -1 })).toThrow(
      /maxStreamRetries/,
    );
  });

  it('accepts maxStreamRetries of 0 (no retries)', () => {
    expect(resolveConfig({ ...BASE, maxStreamRetries: 0 }).maxStreamRetries).toBe(
      0,
    );
  });
});
