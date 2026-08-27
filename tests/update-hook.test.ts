import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../src/client.js';
import type { Platform, EventSourceLike } from '../src/platform/types.js';
import type { FlagDto, GetFlagsResponse } from '../src/core/types.js';
import { createHash } from 'crypto';

function md5(input: string): Uint8Array {
  return createHash('md5').update(input, 'utf8').digest();
}

function makeFlag(key: string, version = 1): FlagDto {
  return {
    key,
    version,
    type: 'Boolean',
    enabled: true,
    variations: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    rules: [],
    fallthrough: { type: 'Fixed', variation: 'on' },
    offVariation: 'off',
  };
}

function makeResponse(flags: FlagDto[], version = 1): GetFlagsResponse {
  return { environment: 'test', version, flags, segments: [] };
}

type MockEventSource = EventSourceLike & {
  emit: (type: string, data?: string) => void;
};

function createMockPlatform(): Platform & {
  mockEventSources: MockEventSource[];
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const mockEventSources: MockEventSource[] = [];
  const fetchMock = vi.fn();

  return {
    md5,
    createEventSource: () => {
      const listeners = new Map<string, ((event: { data: string }) => void)[]>();
      const es: MockEventSource = {
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
      mockEventSources.push(es);
      return es;
    },
    fetch: fetchMock,
    mockEventSources,
    fetchMock,
  };
}

describe("client.on('update')", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await FeatureflipClient.resetForTesting();
  });

  async function createStreamingClient(
    platform: ReturnType<typeof createMockPlatform>,
    flags: FlagDto[] = [makeFlag('bool-flag')],
  ) {
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse(flags),
    });

    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true },
      platform,
    );
    await client.waitForInitialization();
    return client;
  }

  it('does not fire for the initial flag load', async () => {
    const platform = createMockPlatform();
    const listener = vi.fn();

    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse([makeFlag('bool-flag')]),
    });
    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true },
      platform,
    );
    client.on('update', listener);
    await client.waitForInitialization();

    expect(listener).not.toHaveBeenCalled();

    await client.close();
  });

  it('fires with the changed key when a flag is updated over SSE', async () => {
    const platform = createMockPlatform();
    const client = await createStreamingClient(platform);
    const listener = vi.fn();
    client.on('update', listener);

    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeFlag('bool-flag', 2),
    });
    platform.mockEventSources[0].emit('flag.updated', JSON.stringify({ key: 'bool-flag' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(listener).toHaveBeenCalledWith(['bool-flag']);

    await client.close();
  });

  it('fires when a flag is deleted over SSE', async () => {
    const platform = createMockPlatform();
    const client = await createStreamingClient(platform);
    const listener = vi.fn();
    client.on('update', listener);

    platform.mockEventSources[0].emit('flag.deleted', JSON.stringify({ key: 'bool-flag' }));

    expect(listener).toHaveBeenCalledWith(['bool-flag']);

    await client.close();
  });

  it('fires only for flags that changed in a poll snapshot', async () => {
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse([makeFlag('flag-a'), makeFlag('flag-b')]),
    });

    const client = FeatureflipClient.get(
      {
        sdkKey: 'test-key',
        baseUrl: 'http://localhost:5000',
        streaming: false,
        pollInterval: 1000,
      },
      platform,
    );
    await client.waitForInitialization();

    const listener = vi.fn();
    client.on('update', listener);

    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse([makeFlag('flag-a', 2), makeFlag('flag-b')], 2),
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(['flag-a']);

    await client.close();
  });

  it('does not fire when a poll returns an unchanged snapshot', async () => {
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse([makeFlag('flag-a')]),
    });

    const client = FeatureflipClient.get(
      {
        sdkKey: 'test-key',
        baseUrl: 'http://localhost:5000',
        streaming: false,
        pollInterval: 1000,
      },
      platform,
    );
    await client.waitForInitialization();

    const listener = vi.fn();
    client.on('update', listener);

    await vi.advanceTimersByTimeAsync(3000);

    expect(listener).not.toHaveBeenCalled();

    await client.close();
  });

  it('stops delivering after the returned unsubscribe is called', async () => {
    const platform = createMockPlatform();
    const client = await createStreamingClient(platform);
    const listener = vi.fn();

    const unsubscribe = client.on('update', listener);
    unsubscribe();

    platform.mockEventSources[0].emit('flag.deleted', JSON.stringify({ key: 'bool-flag' }));

    expect(listener).not.toHaveBeenCalled();

    await client.close();
  });

  it('stops delivering after off()', async () => {
    const platform = createMockPlatform();
    const client = await createStreamingClient(platform);
    const listener = vi.fn();

    client.on('update', listener);
    client.off('update', listener);

    platform.mockEventSources[0].emit('flag.deleted', JSON.stringify({ key: 'bool-flag' }));

    expect(listener).not.toHaveBeenCalled();

    await client.close();
  });

  it('isolates a throwing listener from the others', async () => {
    const platform = createMockPlatform();
    const client = await createStreamingClient(platform);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    client.on('update', bad);
    client.on('update', good);

    platform.mockEventSources[0].emit('flag.deleted', JSON.stringify({ key: 'bool-flag' }));

    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    await client.close();
  });

  it('drops a handle\'s listeners when that handle closes, leaving siblings intact', async () => {
    const platform = createMockPlatform();
    const first = await createStreamingClient(platform);
    const second = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true },
      platform,
    );

    const closedListener = vi.fn();
    const liveListener = vi.fn();
    second.on('update', closedListener);
    first.on('update', liveListener);

    await second.close();

    platform.mockEventSources[0].emit('flag.deleted', JSON.stringify({ key: 'bool-flag' }));

    expect(closedListener).not.toHaveBeenCalled();
    expect(liveListener).toHaveBeenCalledWith(['bool-flag']);

    await first.close();
  });
});
