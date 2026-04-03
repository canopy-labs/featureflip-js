import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../src/client.js';
import type { Platform, EventSourceLike } from '../src/platform/types.js';
import type { GetFlagsResponse } from '../src/core/types.js';
import { createHash } from 'crypto';

function md5(input: string): Uint8Array {
  return createHash('md5').update(input, 'utf8').digest();
}

function makeFlagResponse(): GetFlagsResponse {
  return {
    environment: 'test',
    version: 1,
    flags: [
      {
        key: 'bool-flag',
        version: 1,
        type: 'Boolean',
        enabled: true,
        variations: [
          { key: 'on', value: true },
          { key: 'off', value: false },
        ],
        rules: [],
        fallthrough: { type: 'Fixed', variation: 'on' },
        offVariation: 'off',
      },
    ],
    segments: [],
  };
}

type MockEventSource = EventSourceLike & {
  listeners: Map<string, ((event: { data: string }) => void)[]>;
  emit: (type: string, data?: string) => void;
};

function createMockPlatform(): Platform & {
  mockEventSources: MockEventSource[];
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const mockEventSources: MockEventSource[] = [];

  const createMockEventSource = (): MockEventSource => {
    const listeners = new Map<string, ((event: { data: string }) => void)[]>();
    return {
      listeners,
      addEventListener(type: string, listener: (event: { data: string }) => void) {
        const existing = listeners.get(type) ?? [];
        existing.push(listener);
        listeners.set(type, existing);
      },
      close: vi.fn(),
      readyState: 1,
      emit(type: string, data?: string) {
        for (const listener of listeners.get(type) ?? []) {
          listener({ data: data ?? '' });
        }
      },
    };
  };

  const fetchMock = vi.fn();

  return {
    md5,
    createEventSource: () => {
      const es = createMockEventSource();
      mockEventSources.push(es);
      return es;
    },
    fetch: fetchMock,
    mockEventSources,
    fetchMock,
  };
}

describe('SSE reconnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should calculate exponential backoff delays capped at 30s', () => {
    const getBackoffDelay = (attempt: number): number => {
      return Math.min(1000 * Math.pow(2, attempt), 30_000);
    };

    expect(getBackoffDelay(0)).toBe(1000);   // 1s
    expect(getBackoffDelay(1)).toBe(2000);   // 2s
    expect(getBackoffDelay(2)).toBe(4000);   // 4s
    expect(getBackoffDelay(3)).toBe(8000);   // 8s
    expect(getBackoffDelay(4)).toBe(16000);  // 16s
    expect(getBackoffDelay(5)).toBe(30000);  // capped at 30s
    expect(getBackoffDelay(10)).toBe(30000); // still capped
  });

  it('should reconnect with exponential backoff on error', async () => {
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeFlagResponse(),
    });

    const client = new FeatureflipClient(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true, maxStreamRetries: 3 },
      platform,
    );
    await client.waitForInitialization();

    // Initial EventSource created during initialization
    expect(platform.mockEventSources).toHaveLength(1);

    // Simulate error on first EventSource
    platform.mockEventSources[0].emit('error');

    // EventSource should be closed
    expect(platform.mockEventSources[0].close).toHaveBeenCalled();

    // After 1s (first retry delay), a new EventSource should be created
    await vi.advanceTimersByTimeAsync(1000);
    expect(platform.mockEventSources).toHaveLength(2);

    // Simulate error on second EventSource
    platform.mockEventSources[1].emit('error');

    // After 2s (second retry delay), another EventSource should be created
    await vi.advanceTimersByTimeAsync(2000);
    expect(platform.mockEventSources).toHaveLength(3);

    await client.close();
  });

  it('should fall back to polling after max retries exceeded', async () => {
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeFlagResponse(),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new FeatureflipClient(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true, maxStreamRetries: 2 },
      platform,
    );
    await client.waitForInitialization();

    // Initial EventSource
    expect(platform.mockEventSources).toHaveLength(1);

    // First error -> retry after 1s
    platform.mockEventSources[0].emit('error');
    await vi.advanceTimersByTimeAsync(1000);
    expect(platform.mockEventSources).toHaveLength(2);

    // Second error -> retry after 2s
    platform.mockEventSources[1].emit('error');
    await vi.advanceTimersByTimeAsync(2000);
    expect(platform.mockEventSources).toHaveLength(3);

    // Third error -> max retries exceeded, should fall back to polling
    platform.mockEventSources[2].emit('error');

    // No new EventSource should be created
    await vi.advanceTimersByTimeAsync(10000);
    expect(platform.mockEventSources).toHaveLength(3);

    // Warning should have been logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('falling back to polling'),
    );

    warnSpy.mockRestore();
    await client.close();
  });

  it('should reset retry count on successful connection', async () => {
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeFlagResponse(),
    });

    const client = new FeatureflipClient(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true, maxStreamRetries: 3 },
      platform,
    );
    await client.waitForInitialization();

    // First error
    platform.mockEventSources[0].emit('error');
    await vi.advanceTimersByTimeAsync(1000);
    expect(platform.mockEventSources).toHaveLength(2);

    // Simulate successful reconnection (open event)
    platform.mockEventSources[1].emit('open');

    // Another error after successful connection
    platform.mockEventSources[1].emit('error');

    // Should retry with 1s delay again (retry count was reset)
    await vi.advanceTimersByTimeAsync(1000);
    expect(platform.mockEventSources).toHaveLength(3);

    await client.close();
  });

  it('should clean up retry timer on close', async () => {
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeFlagResponse(),
    });

    const client = new FeatureflipClient(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true, maxStreamRetries: 5 },
      platform,
    );
    await client.waitForInitialization();

    // Trigger error to start a retry timer
    platform.mockEventSources[0].emit('error');

    // Close before the retry timer fires
    await client.close();

    // Advance time past when retry would have fired
    await vi.advanceTimersByTimeAsync(5000);

    // No new EventSource should have been created (timer was cleared)
    expect(platform.mockEventSources).toHaveLength(1);
  });
});
