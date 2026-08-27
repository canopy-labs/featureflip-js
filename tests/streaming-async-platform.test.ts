import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../src/client.js';
import type { Platform, EventSourceLike } from '../src/platform/types.js';
import type { GetFlagsResponse } from '../src/core/types.js';
import { createHash } from 'crypto';

// #2246: Platform.createEventSource may now return a Promise, because the Node
// platform dynamic-imports its ESM-only `eventsource` dependency rather than
// require()ing it. That await introduces three states the synchronous version
// could not reach, none of which the existing streaming tests cover:
//
//   1. the creation REJECTS — previously a synchronous throw straight out of
//      initialize(), which rejects waitForInitialization(), an API whose own
//      doc comment says it never rejects;
//   2. close() lands while the creation is still in flight, so shutdown() runs
//      before the instance exists and can never close it;
//   3. an 'error' arrives from an instance that has already been replaced.
//
// These are about the core's handling of an async platform, so they use a
// controllable async mock rather than the real eventsource.

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
  emit: (type: string, data?: string) => void;
  close: ReturnType<typeof vi.fn>;
};

function createMockEventSource(): MockEventSource {
  const listeners = new Map<string, ((event: { data: string }) => void)[]>();
  return {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    close: vi.fn(),
    readyState: 1,
    emit(type, data) {
      for (const listener of listeners.get(type) ?? []) listener({ data: data ?? '' });
    },
  };
}

/** A platform whose createEventSource resolution the test drives by hand. */
function createDeferredPlatform(): Platform & {
  created: MockEventSource[];
  settle: (() => void)[];
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const created: MockEventSource[] = [];
  const settle: (() => void)[] = [];
  const fetchMock = vi.fn();

  return {
    md5,
    createEventSource: () =>
      new Promise<EventSourceLike>((resolve) => {
        const es = createMockEventSource();
        settle.push(() => {
          created.push(es);
          resolve(es);
        });
      }),
    fetch: fetchMock,
    created,
    settle,
    fetchMock,
  };
}

const okFetch = () => ({ ok: true, json: async () => makeFlagResponse() });

describe('async Platform.createEventSource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await FeatureflipClient.resetForTesting();
    vi.restoreAllMocks();
  });

  it('resolves waitForInitialization and polls instead when creation rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(okFetch());
    const platform: Platform = {
      md5,
      // What a missing/broken ESM-only dependency looks like to the core.
      createEventSource: () =>
        Promise.reject(
          Object.assign(new Error("Cannot find package 'eventsource'"), {
            code: 'ERR_MODULE_NOT_FOUND',
          }),
        ),
      fetch: fetchMock,
    };

    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true, pollInterval: 1000 },
      platform,
    );

    // The contract: never rejects, even though the data source could not start.
    await expect(client.waitForInitialization()).resolves.toBeUndefined();

    // Degraded, not dead: the initial snapshot still serves...
    expect(client.boolVariation('bool-flag', { key: 'u1' }, false)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to polling'),
      expect.anything(),
    );

    // ...and polling took over, so config changes still land.
    const callsAfterInit = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterInit);

    await client.close();
  });

  it('closes an EventSource that resolves after the client was closed', async () => {
    const platform = createDeferredPlatform();
    platform.fetchMock.mockResolvedValue(okFetch());

    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true },
      platform,
    );
    const initializing = client.waitForInitialization();

    // Let the initial fetch settle so we are parked on the pending creation.
    await vi.advanceTimersByTimeAsync(0);
    expect(platform.settle).toHaveLength(1);
    expect(platform.created).toHaveLength(0);

    // Close mid-flight: shutdown() runs now and cannot see the instance.
    await client.close();

    // The import finally lands. Nothing else will ever hold this instance, so
    // if the core does not close it here the SSE socket stays open for the
    // life of the process.
    platform.settle[0]();
    await initializing;
    await vi.advanceTimersByTimeAsync(0);

    expect(platform.created).toHaveLength(1);
    expect(platform.created[0].close).toHaveBeenCalled();
  });

  it('does not resolve waitForInitialization until the stream is established', async () => {
    const platform = createDeferredPlatform();
    platform.fetchMock.mockResolvedValue(okFetch());

    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true },
      platform,
    );

    let resolved = false;
    const initializing = client.waitForInitialization().then(() => {
      resolved = true;
    });

    // The initial fetch has settled; only the EventSource creation is pending.
    await vi.advanceTimersByTimeAsync(0);
    expect(platform.settle).toHaveLength(1);

    // Must still be waiting. If initialize() only fires the data source off
    // instead of awaiting it, callers resume with no listeners attached yet and
    // silently miss any update that lands in that window — and every existing
    // streaming test, which asserts on the EventSource right after awaiting
    // this, would be racing rather than testing.
    expect(resolved).toBe(false);

    platform.settle[0]();
    await initializing;

    expect(resolved).toBe(true);
    expect(platform.created).toHaveLength(1);

    await client.close();
  });

  it('delivers stream events through an async platform', async () => {
    const platform = createDeferredPlatform();
    platform.fetchMock.mockResolvedValue(okFetch());

    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true },
      platform,
    );
    const initializing = client.waitForInitialization();

    await vi.advanceTimersByTimeAsync(0);
    platform.settle[0]();
    await initializing;

    expect(platform.created).toHaveLength(1);

    const updated: GetFlagsResponse = {
      ...makeFlagResponse(),
      version: 2,
      flags: [{ ...makeFlagResponse().flags[0], enabled: false, version: 2 }],
    };
    platform.created[0].emit('sync', JSON.stringify(updated));

    expect(client.boolVariation('bool-flag', { key: 'u1' }, true)).toBe(false);

    await client.close();
  });

  it('ignores a late error from an EventSource that was already replaced', async () => {
    const platform = createDeferredPlatform();
    platform.fetchMock.mockResolvedValue(okFetch());

    const client = FeatureflipClient.get(
      {
        sdkKey: 'test-key',
        baseUrl: 'http://localhost:5000',
        streaming: true,
        maxStreamRetries: 3,
      },
      platform,
    );
    const initializing = client.waitForInitialization();
    await vi.advanceTimersByTimeAsync(0);
    platform.settle[0]();
    await initializing;

    const first = platform.created[0];

    // First stream fails; the retry timer fires and a second one is created.
    first.emit('error');
    await vi.advanceTimersByTimeAsync(1000);
    platform.settle[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(platform.created).toHaveLength(2);

    // A second 'error' from the RETIRED first stream. Without the identity
    // check this drops the live stream's reference and schedules a duplicate
    // retry, so the client thrashes between connections it never reads.
    //
    // Counted on `settle` rather than `created`: `created` only grows when a
    // pending creation is settled, so a spurious retry that is still in flight
    // is invisible there — which is exactly how this assertion passed against
    // the unguarded code while proving nothing.
    first.emit('error');
    await vi.advanceTimersByTimeAsync(5000);

    expect(platform.settle).toHaveLength(2);
    expect(platform.created[1].close).not.toHaveBeenCalled();

    // The live stream must still be wired to the store — the unguarded path
    // nulls it out, so this update would be applied to nothing.
    const updated: GetFlagsResponse = {
      ...makeFlagResponse(),
      version: 3,
      flags: [{ ...makeFlagResponse().flags[0], enabled: false, version: 3 }],
    };
    platform.created[1].emit('sync', JSON.stringify(updated));
    expect(client.boolVariation('bool-flag', { key: 'u1' }, true)).toBe(false);

    await client.close();
  });
});
