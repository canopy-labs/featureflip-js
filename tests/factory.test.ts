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

function createMockPlatform(): Platform & {
  fetchMock: ReturnType<typeof vi.fn>;
  createEventSourceMock: ReturnType<typeof vi.fn>;
} {
  const mockEventSource: EventSourceLike = {
    addEventListener: () => {},
    close: () => {},
    readyState: 1,
  };
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => makeFlagResponse(),
  });
  const createEventSourceMock = vi.fn().mockReturnValue(mockEventSource);
  return {
    md5,
    createEventSource: createEventSourceMock,
    fetch: fetchMock,
    fetchMock,
    createEventSourceMock,
  };
}

// Each test uses a unique SDK key to avoid cross-test contamination in the
// process-wide factory cache — parallel vitest workers each get their own
// process, but within a file tests share state.
let keyCounter = 0;
function uniqueKey(name: string): string {
  keyCounter++;
  return `test-${name}-${keyCounter}`;
}

describe('FeatureflipClient.get (factory)', () => {
  beforeEach(() => {
    // Real timers: tests wait for microtasks, not scheduled timers.
    vi.useRealTimers();
  });

  afterEach(async () => {
    await FeatureflipClient.resetForTesting();
  });

  it('returns a working client for a fresh SDK key', async () => {
    const platform = createMockPlatform();
    const key = uniqueKey('fresh');

    const client = FeatureflipClient.get(
      { sdkKey: key, baseUrl: 'http://localhost:5000' },
      platform,
    );

    await client.waitForInitialization();
    expect(client.isInitialized).toBe(true);
    expect(client.boolVariation('bool-flag', {}, false)).toBe(true);

    await client.close();
  });

  it('second get() with same key constructs only ONE shared core', async () => {
    const platform = createMockPlatform();
    const key = uniqueKey('dedupe');

    const h1 = FeatureflipClient.get(
      { sdkKey: key, baseUrl: 'http://localhost:5000' },
      platform,
    );
    const h2 = FeatureflipClient.get(
      { sdkKey: key, baseUrl: 'http://localhost:5000' },
      platform,
    );

    await h1.waitForInitialization();
    await h2.waitForInitialization();

    // Only ONE initial flag fetch happened — the second get() reused the core.
    const flagFetches = platform.fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).endsWith('/v1/sdk/flags'),
    );
    expect(flagFetches.length).toBe(1);

    // Handles are distinct instances but share state — both see the same flags.
    expect(h1).not.toBe(h2);
    expect(h1.boolVariation('bool-flag', {}, false)).toBe(true);
    expect(h2.boolVariation('bool-flag', {}, false)).toBe(true);

    // Refcount is 2 (two handles outstanding).
    expect(FeatureflipClient.debugRefCount(key)).toBe(2);

    await h1.close();
    await h2.close();
  });

  it('get() with different SDK keys constructs independent cores', async () => {
    const platform1 = createMockPlatform();
    const platform2 = createMockPlatform();
    const keyA = uniqueKey('a');
    const keyB = uniqueKey('b');

    const hA = FeatureflipClient.get(
      { sdkKey: keyA, baseUrl: 'http://localhost:5000' },
      platform1,
    );
    const hB = FeatureflipClient.get(
      { sdkKey: keyB, baseUrl: 'http://localhost:5000' },
      platform2,
    );

    await hA.waitForInitialization();
    await hB.waitForInitialization();

    // Each key caused its own fetch — independent cores.
    expect(platform1.fetchMock).toHaveBeenCalled();
    expect(platform2.fetchMock).toHaveBeenCalled();
    expect(FeatureflipClient.debugLiveCoreCount).toBeGreaterThanOrEqual(2);
    expect(FeatureflipClient.debugRefCount(keyA)).toBe(1);
    expect(FeatureflipClient.debugRefCount(keyB)).toBe(1);

    await hA.close();
    await hB.close();
  });

  it('after disposing the only handle, the next get() constructs a fresh core', async () => {
    const platform = createMockPlatform();
    const key = uniqueKey('recreate');

    const h1 = FeatureflipClient.get(
      { sdkKey: key, baseUrl: 'http://localhost:5000' },
      platform,
    );
    await h1.waitForInitialization();
    await h1.close();

    // Map entry gone — refcount 0.
    expect(FeatureflipClient.debugRefCount(key)).toBe(0);

    const h2 = FeatureflipClient.get(
      { sdkKey: key, baseUrl: 'http://localhost:5000' },
      platform,
    );
    await h2.waitForInitialization();

    // Two separate flag fetches — one per construction.
    const flagFetches = platform.fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).endsWith('/v1/sdk/flags'),
    );
    expect(flagFetches.length).toBe(2);

    await h2.close();
  });

  it('disposing one of two handles leaves the other functional', async () => {
    const platform = createMockPlatform();
    const key = uniqueKey('shared');

    const h1 = FeatureflipClient.get(
      { sdkKey: key, baseUrl: 'http://localhost:5000' },
      platform,
    );
    const h2 = FeatureflipClient.get(
      { sdkKey: key, baseUrl: 'http://localhost:5000' },
      platform,
    );
    await h1.waitForInitialization();

    expect(FeatureflipClient.debugRefCount(key)).toBe(2);
    await h1.close();
    expect(FeatureflipClient.debugRefCount(key)).toBe(1);

    // h2 still works — core is still live.
    expect(h2.isInitialized).toBe(true);
    expect(h2.boolVariation('bool-flag', {}, false)).toBe(true);

    await h2.close();
    expect(FeatureflipClient.debugRefCount(key)).toBe(0);
  });

  it('double-close on the same handle is idempotent', async () => {
    const platform = createMockPlatform();
    const key = uniqueKey('double');

    const h1 = FeatureflipClient.get(
      { sdkKey: key, baseUrl: 'http://localhost:5000' },
      platform,
    );
    const h2 = FeatureflipClient.get(
      { sdkKey: key, baseUrl: 'http://localhost:5000' },
      platform,
    );
    await h1.waitForInitialization();

    expect(FeatureflipClient.debugRefCount(key)).toBe(2);

    await h1.close();
    await h1.close(); // Second close on the same handle is a no-op.
    await h1.close();

    // Refcount decremented only once — h2 is still alive.
    expect(FeatureflipClient.debugRefCount(key)).toBe(1);
    expect(h2.isInitialized).toBe(true);

    await h2.close();
    expect(FeatureflipClient.debugRefCount(key)).toBe(0);
  });

  it('concurrent get() for the same key yields one shared core', async () => {
    // JS is single-threaded, but module-level init work can still race across
    // microtasks. Fire off many get() calls in parallel and verify exactly one
    // flag fetch happened.
    const platform = createMockPlatform();
    const key = uniqueKey('concurrent');

    const handles = await Promise.all(
      Array.from({ length: 32 }, () =>
        Promise.resolve(
          FeatureflipClient.get(
            { sdkKey: key, baseUrl: 'http://localhost:5000' },
            platform,
          ),
        ),
      ),
    );

    await Promise.all(handles.map((h) => h.waitForInitialization()));

    const flagFetches = platform.fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).endsWith('/v1/sdk/flags'),
    );
    expect(flagFetches.length).toBe(1);
    expect(FeatureflipClient.debugRefCount(key)).toBe(32);

    for (const h of handles) {
      await h.close();
    }
    expect(FeatureflipClient.debugRefCount(key)).toBe(0);
  });

  it('get() with different options on an existing key warns and reuses cache', async () => {
    const platform = createMockPlatform();
    const key = uniqueKey('warn');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const h1 = FeatureflipClient.get(
      { sdkKey: key, baseUrl: 'http://localhost:5000', streaming: true },
      platform,
    );
    await h1.waitForInitialization();

    // Different options — should warn but return a handle on the cached core.
    const h2 = FeatureflipClient.get(
      { sdkKey: key, baseUrl: 'http://localhost:5001', streaming: false },
      platform,
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('different options'),
    );
    // Still only one flag fetch, proving h2 reused the existing core.
    const flagFetches = platform.fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).endsWith('/v1/sdk/flags'),
    );
    expect(flagFetches.length).toBe(1);

    await h1.close();
    await h2.close();
    warnSpy.mockRestore();
  });

  it('get() without sdkKey throws', () => {
    const platform = createMockPlatform();
    expect(() =>
      FeatureflipClient.get(
        { sdkKey: '', baseUrl: 'http://localhost:5000' },
        platform,
      ),
    ).toThrow('sdkKey is required');
  });

  it('forTesting creates an independent client that is NOT in the factory cache', () => {
    const before = FeatureflipClient.debugLiveCoreCount;
    const client = FeatureflipClient.forTesting({ 'my-flag': true });
    expect(client.isInitialized).toBe(true);
    expect(client.boolVariation('my-flag', {}, false)).toBe(true);
    // forTesting core is not registered in the factory map.
    expect(FeatureflipClient.debugLiveCoreCount).toBe(before);
  });
});
