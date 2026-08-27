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

describe('SSE event types', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await FeatureflipClient.resetForTesting();
  });

  async function createStreamingClient(platform: ReturnType<typeof createMockPlatform>) {
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeFlagResponse(),
    });

    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true },
      platform,
    );
    await client.waitForInitialization();
    return client;
  }

  it('should fetch single flag on flag.updated event', async () => {
    const platform = createMockPlatform();
    const client = await createStreamingClient(platform);

    // Clear fetch calls from initialization
    platform.fetchMock.mockClear();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        key: 'my-flag',
        version: 2,
        type: 'Boolean',
        enabled: true,
        variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
        rules: [],
        fallthrough: { type: 'Fixed', variation: 'on' },
        offVariation: 'off',
      }),
    });

    platform.mockEventSources[0].emit('flag.updated', JSON.stringify({ key: 'my-flag' }));

    // Allow the async fetch to resolve
    await vi.advanceTimersByTimeAsync(0);

    expect(platform.fetchMock).toHaveBeenCalledWith(
      'http://localhost:5000/v1/sdk/flags/my-flag',
      expect.any(Object),
    );

    await client.close();
  });

  it('should fetch single flag on flag.created event', async () => {
    const platform = createMockPlatform();
    const client = await createStreamingClient(platform);

    platform.fetchMock.mockClear();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        key: 'new-flag',
        version: 1,
        type: 'Boolean',
        enabled: true,
        variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
        rules: [],
        fallthrough: { type: 'Fixed', variation: 'on' },
        offVariation: 'off',
      }),
    });

    platform.mockEventSources[0].emit('flag.created', JSON.stringify({ key: 'new-flag' }));

    await vi.advanceTimersByTimeAsync(0);

    expect(platform.fetchMock).toHaveBeenCalledWith(
      'http://localhost:5000/v1/sdk/flags/new-flag',
      expect.any(Object),
    );

    await client.close();
  });

  it('should remove flag from store on flag.deleted event', async () => {
    const platform = createMockPlatform();
    const client = await createStreamingClient(platform);

    // Verify flag exists before deletion
    expect(client.boolVariation('bool-flag', {}, false)).toBe(true);

    platform.mockEventSources[0].emit('flag.deleted', JSON.stringify({ key: 'bool-flag' }));

    // Flag should be removed — variation returns default
    expect(client.boolVariation('bool-flag', {}, false)).toBe(false);

    await client.close();
  });

  it('should refetch all flags on segment.updated event', async () => {
    const platform = createMockPlatform();
    const client = await createStreamingClient(platform);

    platform.fetchMock.mockClear();
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeFlagResponse(),
    });

    platform.mockEventSources[0].emit('segment.updated', JSON.stringify({ key: 'seg-1' }));

    await vi.advanceTimersByTimeAsync(0);

    expect(platform.fetchMock).toHaveBeenCalledWith(
      'http://localhost:5000/v1/sdk/flags',
      expect.any(Object),
    );

    await client.close();
  });

  it('should ignore old hyphen-separated flag-updated event', async () => {
    const platform = createMockPlatform();
    const client = await createStreamingClient(platform);

    platform.fetchMock.mockClear();

    platform.mockEventSources[0].emit('flag-updated', JSON.stringify({ key: 'my-flag' }));

    await vi.advanceTimersByTimeAsync(0);

    expect(platform.fetchMock).not.toHaveBeenCalled();

    await client.close();
  });
});
