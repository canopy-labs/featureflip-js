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

  afterEach(async () => {
    vi.useRealTimers();
    await FeatureflipClient.resetForTesting();
  });

  it('escalates the reconnect delay, caps it at 30s, and jitters every level', async () => {
    // Asserted against the SDK's own scheduling, not a formula retyped into the
    // test: the version this replaces re-implemented the delay locally and so
    // would have passed unchanged no matter what the SDK did.
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({ ok: true, json: async () => makeFlagResponse() });

    // Math.random() === 1 puts the jittered delay at the top of its [d/2, d] band,
    // which is the pre-jitter delay — so the ceilings stay exactly assertable.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);

    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true, maxStreamRetries: 99 },
      platform,
    );
    await client.waitForInitialization();

    for (const ceiling of [1000, 2000, 4000, 8000, 16000, 30_000, 30_000]) {
      const before = platform.mockEventSources.length;
      platform.mockEventSources[before - 1].emit('error');

      // Nothing one millisecond early...
      await vi.advanceTimersByTimeAsync(ceiling - 1);
      expect(platform.mockEventSources).toHaveLength(before);
      // ...and exactly one reconnect on the boundary.
      await vi.advanceTimersByTimeAsync(1);
      expect(platform.mockEventSources).toHaveLength(before + 1);
    }

    // The jitter itself: the drops this absorbs are fleet-wide (#2457), so a
    // constant first delay reconnects every client in lockstep (#2508).
    randomSpy.mockReturnValue(0);
    const before = platform.mockEventSources.length;
    platform.mockEventSources[before - 1].emit('error');
    await vi.advanceTimersByTimeAsync(15_000); // half of the 30s ceiling
    expect(platform.mockEventSources).toHaveLength(before + 1);

    randomSpy.mockRestore();
    await client.close();
  });

  it('should reconnect with exponential backoff on error', async () => {
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeFlagResponse(),
    });

    const client = FeatureflipClient.get(
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

  it('falls back to polling after max retries AND keeps retrying the stream', async () => {
    // #3071: the fallback is additive. It used to `return`, so nothing ever
    // re-opened the stream — the process polled, blind to real-time updates
    // (kill switches included), until it restarted.
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeFlagResponse(),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = FeatureflipClient.get(
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

    // Third error -> the fallback arms, and the stream retries underneath it.
    platform.mockEventSources[2].emit('error');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(platform.mockEventSources).toHaveLength(4);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('falling back to polling'),
    );
    // Armed once, not re-announced on every failure past the threshold.
    const fallbackWarnings = warnSpy.mock.calls.filter(([msg]) =>
      typeof msg === 'string' && msg.includes('falling back to polling'),
    );
    platform.mockEventSources[3].emit('error');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(platform.mockEventSources).toHaveLength(5);
    expect(
      warnSpy.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && msg.includes('falling back to polling'),
      ),
    ).toHaveLength(fallbackWarnings.length);

    warnSpy.mockRestore();
    await client.close();
  });

  it('retires the fallback poller once the stream delivers a sync again', async () => {
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeFlagResponse(),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = FeatureflipClient.get(
      {
        sdkKey: 'test-key',
        baseUrl: 'http://localhost:5000',
        streaming: true,
        maxStreamRetries: 0,
        pollInterval: 1000,
      },
      platform,
    );
    await client.waitForInitialization();

    // Straight to the fallback (maxStreamRetries: 0), then let it poll twice.
    platform.mockEventSources[0].emit('error');
    const afterInit = platform.fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(platform.fetchMock.mock.calls.length).toBeGreaterThan(afterInit);

    // The stream comes back and replays its snapshot: the poller is now redundant,
    // and leaving it running means one request per interval per instance forever —
    // plus whole-store replaces that revert deltas this stream applies.
    const latest = platform.mockEventSources[platform.mockEventSources.length - 1];
    latest.emit('sync', JSON.stringify(makeFlagResponse()));

    const afterRecovery = platform.fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(platform.fetchMock.mock.calls.length).toBe(afterRecovery);

    warnSpy.mockRestore();
    await client.close();
  });

  it('resets the retry count on a delivered sync, not on a bare open', async () => {
    // An accept-then-close server satisfies `open` on every cycle. Resetting there
    // meant the counter never accumulated, so this SDK reconnected at a flat 1s
    // forever and never reached its own fallback. Every other SDK in the fleet
    // resets on a delivered frame.
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeFlagResponse(),
    });

    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true, maxStreamRetries: 99 },
      platform,
    );
    await client.waitForInitialization();

    // Accept-then-close twice: the delay must keep escalating.
    platform.mockEventSources[0].emit('open');
    platform.mockEventSources[0].emit('error');
    await vi.advanceTimersByTimeAsync(1000);
    expect(platform.mockEventSources).toHaveLength(2);

    platform.mockEventSources[1].emit('open');
    platform.mockEventSources[1].emit('error');
    await vi.advanceTimersByTimeAsync(1000);
    expect(platform.mockEventSources)
      .toHaveLength(2); // 1s is no longer enough — the second delay is [1s, 2s]
    await vi.advanceTimersByTimeAsync(1000);
    expect(platform.mockEventSources).toHaveLength(3);

    // A delivered sync is what actually resets it.
    platform.mockEventSources[2].emit('sync', JSON.stringify(makeFlagResponse()));
    platform.mockEventSources[2].emit('error');
    await vi.advanceTimersByTimeAsync(1000);
    expect(platform.mockEventSources).toHaveLength(4);

    await client.close();
  });

  it('does not reject and serves defaults when the initial fetch fails', async () => {
    const platform = createMockPlatform();
    platform.fetchMock.mockRejectedValue(new Error('eval-api down'));

    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true, maxStreamRetries: 3 },
      platform,
    );

    // Must NOT reject even though the initial fetch failed (degraded-but-recovering).
    await expect(client.waitForInitialization()).resolves.toBeUndefined();
    expect(client.isInitialized).toBe(true);
    // Store is empty -> serves the caller default.
    expect(client.boolVariation('bool-flag', {}, false)).toBe(false);
    // Data source started despite the failed init, so it can self-heal.
    expect(platform.mockEventSources).toHaveLength(1);

    await client.close();
  });

  it('applies a sync snapshot as a full store replace', async () => {
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({ ok: true, json: async () => makeFlagResponse() });

    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true },
      platform,
    );
    await client.waitForInitialization();
    expect(client.boolVariation('bool-flag', {}, false)).toBe(true);

    // Server sends a sync snapshot on (re)connect that no longer contains bool-flag
    // (it was deleted while this SDK was disconnected).
    const emptySnapshot: GetFlagsResponse = { environment: 'test', version: 2, flags: [], segments: [] };
    platform.mockEventSources[0].emit('sync', JSON.stringify(emptySnapshot));

    // Full replace -> bool-flag is gone -> serves the caller default.
    expect(client.boolVariation('bool-flag', {}, false)).toBe(false);

    await client.close();
  });

  it('should clean up retry timer on close', async () => {
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeFlagResponse(),
    });

    const client = FeatureflipClient.get(
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
