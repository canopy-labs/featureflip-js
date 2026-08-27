import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../src/client.js';
import type { Platform, EventSourceLike } from '../src/platform/types.js';
import type { GetFlagsResponse, SdkEventDto } from '../src/core/types.js';
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
} {
  const listeners = new Map<string, ((event: { data: string }) => void)[]>();
  const mockEventSource: EventSourceLike = {
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    close: vi.fn(),
    readyState: 1,
  };

  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => makeFlagResponse(),
  });

  return {
    md5,
    createEventSource: vi.fn().mockReturnValue(mockEventSource),
    fetch: fetchMock,
    fetchMock,
  };
}

/** Extract every event sent to the /v1/sdk/events endpoint. */
function capturedEvents(fetchMock: ReturnType<typeof vi.fn>): SdkEventDto[] {
  const events: SdkEventDto[] = [];
  for (const [url, init] of fetchMock.mock.calls) {
    if (typeof url === 'string' && url.endsWith('/v1/sdk/events') && init?.body) {
      events.push(...JSON.parse(init.body as string).events);
    }
  }
  return events;
}

describe('analytics events with camelCase userId alias', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await FeatureflipClient.resetForTesting();
  });

  it('carries the user id on Evaluation, Custom, and Identify events when the context uses the `userId` alias', async () => {
    const platform = createMockPlatform();
    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
      platform,
    );
    await client.waitForInitialization();

    client.boolVariation('bool-flag', { userId: 'alice' }, false);
    client.track('signup_completed', { userId: 'alice' }, { plan: 'pro' });
    client.identify({ userId: 'alice', plan: 'pro' });

    await client.flush();

    const events = capturedEvents(platform.fetchMock);
    const evaluation = events.find((e) => e.type === 'Evaluation');
    const custom = events.find((e) => e.type === 'Custom');
    const identify = events.find((e) => e.type === 'Identify');

    expect(evaluation?.userId).toBe('alice');
    expect(custom?.userId).toBe('alice');
    expect(identify?.userId).toBe('alice');

    // identity must be promoted to the userId field, not left buried in metadata
    expect(identify?.metadata).not.toHaveProperty('userId');
    expect(identify?.metadata).not.toHaveProperty('user_id');

    await client.close();
  });

  it('still carries the user id when the context uses the snake_case `user_id` field', async () => {
    const platform = createMockPlatform();
    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
      platform,
    );
    await client.waitForInitialization();

    client.track('signup_completed', { user_id: 'bob' }, { plan: 'free' });
    client.identify({ user_id: 'bob', plan: 'free' });

    await client.flush();

    const events = capturedEvents(platform.fetchMock);
    const custom = events.find((e) => e.type === 'Custom');
    const identify = events.find((e) => e.type === 'Identify');

    expect(custom?.userId).toBe('bob');
    expect(identify?.userId).toBe('bob');
    expect(identify?.metadata).not.toHaveProperty('user_id');
    expect(identify?.metadata).not.toHaveProperty('userId');

    await client.close();
  });

  // The optional wire fields are omitted rather than sent empty, so the same
  // call produces the same bytes from every server SDK (#2359).
  it('omits metadata entirely when there is nothing to carry', async () => {
    const platform = createMockPlatform();
    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
      platform,
    );
    await client.waitForInitialization();

    client.track('signup_completed', { userId: 'alice' });
    client.track('checkout_started', { userId: 'alice' }, {});
    client.identify({ userId: 'alice' });

    await client.flush();

    const events = capturedEvents(platform.fetchMock);
    const custom = events.filter((e) => e.type === 'Custom');
    const identify = events.find((e) => e.type === 'Identify');

    expect(custom).toHaveLength(2);
    for (const e of custom) {
      expect(e).not.toHaveProperty('metadata');
    }
    expect(identify).not.toHaveProperty('metadata');

    await client.close();
  });

  it('omits userId when the context carries no identity', async () => {
    const platform = createMockPlatform();
    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
      platform,
    );
    await client.waitForInitialization();

    client.identify({ plan: 'pro' });

    await client.flush();

    const identify = capturedEvents(platform.fetchMock).find((e) => e.type === 'Identify');

    expect(identify).not.toHaveProperty('userId');
    expect(identify?.metadata).toEqual({ plan: 'pro' });

    await client.close();
  });
});
