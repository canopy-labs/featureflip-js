import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../src/client.js';
import type { Platform, EventSourceLike } from '../src/platform/types.js';
import type { FlagDto, GetFlagsResponse } from '../src/core/types.js';
import { createHash } from 'crypto';

/**
 * The single-flag DELTA path for #2402's entity drop.
 *
 * The shared `malformedConfigVectors` runner exercises the snapshot path only — it
 * parses a whole `GetFlagsResponse` — so nothing there reaches `fetchSingleFlag`, which
 * is a separate parse boundary with its own guard. That gap matters: a `flag.updated`
 * delta carrying an unevaluable enum is the realistic trigger, since it is exactly what
 * a newer server sends the moment someone edits a flag to use a new serve type.
 *
 * What a delta drop means is also different from a snapshot drop, and is the real
 * assertion here: the store's PREVIOUS copy must survive. Upserting the new one would
 * install a flag this build mis-evaluates; wiping the key would strand callers on their
 * default when a perfectly good older version is already in hand.
 */

function md5(input: string): Uint8Array {
  return createHash('md5').update(input, 'utf8').digest();
}

function seedResponse(): GetFlagsResponse {
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
        for (const listener of listeners.get(type) ?? []) listener({ data: data ?? '' });
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

describe('unevaluable enum on a single-flag delta (#2402)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await FeatureflipClient.resetForTesting();
  });

  async function streamingClient(platform: ReturnType<typeof createMockPlatform>) {
    platform.fetchMock.mockResolvedValue({ ok: true, json: async () => seedResponse() });
    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true },
      platform,
    );
    await client.waitForInitialization();
    return client;
  }

  /** A delta whose fallthrough carries a serve type this build cannot dispatch on. */
  function deltaWith(fallthrough: FlagDto['fallthrough']): FlagDto {
    return {
      key: 'bool-flag',
      version: 2,
      type: 'Boolean',
      enabled: true,
      variations: [
        { key: 'on', value: false },
        { key: 'off', value: false },
      ],
      rules: [],
      fallthrough,
      offVariation: 'off',
    };
  }

  it('keeps the previously stored flag when the delta has an unknown serve type', async () => {
    const platform = createMockPlatform();
    const client = await streamingClient(platform);

    // The seeded flag serves `on` -> true. The delta would serve `on` -> false, so if it
    // were applied the assertion below flips. That is what makes this prove RETENTION
    // rather than merely "no crash".
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => deltaWith({ type: 'Canary', variation: 'on' }),
    });

    platform.mockEventSources[0].emit('flag.updated', JSON.stringify({ key: 'bool-flag' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(client.boolVariation('bool-flag', { userId: 'u' }, false)).toBe(true);

    await client.close();
  });

  it('applies a delta whose serve type is known — the guard must not over-fire', async () => {
    // Positive control. Without it the test above passes just as well against a build
    // that drops EVERY delta, which would be a far worse bug than the one being fixed.
    const platform = createMockPlatform();
    const client = await streamingClient(platform);

    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => deltaWith({ type: 'Fixed', variation: 'on' }),
    });

    platform.mockEventSources[0].emit('flag.updated', JSON.stringify({ key: 'bool-flag' }));
    await vi.advanceTimersByTimeAsync(0);

    // The delta redefines `on` as false, so seeing false proves it was applied.
    expect(client.boolVariation('bool-flag', { userId: 'u' }, true)).toBe(false);

    await client.close();
  });

  it('leaves an ABSENT serve type to the wire-contract validator, not to the drop', async () => {
    const platform = createMockPlatform();
    const client = await streamingClient(platform);

    // Absent is the missing-required-field axis, and js already rejects it: validateFlag
    // requires `fallthrough.type` to be a string and raises MalformedPayloadError (#2315),
    // so the delta never reaches the #2402 guard at all. Pinned because the two axes look
    // alike from the outside — both end with the previous flag still serving — and a
    // later "simplification" that routed absent values through the entity drop instead
    // would silently change which payloads are rejected wholesale. The SDKs deliberately
    // disagree on this case (ruby/python/php default it to And), which is exactly why the
    // drop is scoped to a value that is PRESENT and unrecognised.
    platform.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => deltaWith({ variation: 'on' } as FlagDto['fallthrough']),
    });

    platform.mockEventSources[0].emit('flag.updated', JSON.stringify({ key: 'bool-flag' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(client.boolVariation('bool-flag', { userId: 'u' }, false)).toBe(true);

    await client.close();
  });
});
