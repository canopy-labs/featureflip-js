import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../src/client.js';
import type { Platform, EventSourceLike } from '../src/platform/types.js';
import type { GetFlagsResponse, FlagDto } from '../src/core/types.js';
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
      {
        key: 'string-flag',
        version: 1,
        type: 'String',
        enabled: true,
        variations: [
          { key: 'a', value: 'alpha' },
          { key: 'b', value: 'beta' },
        ],
        rules: [],
        fallthrough: { type: 'Fixed', variation: 'a' },
        offVariation: 'b',
      },
      {
        key: 'disabled-flag',
        version: 1,
        type: 'Boolean',
        enabled: false,
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

function createMockPlatform(opts?: { sseSupportsHeaders?: boolean }): Platform & {
  mockEventSource: EventSourceLike & {
    listeners: Map<string, ((event: { data: string }) => void)[]>;
    emit: (type: string, data: string) => void;
  };
  fetchMock: ReturnType<typeof vi.fn>;
  createEventSourceMock: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, ((event: { data: string }) => void)[]>();
  const mockEventSource = {
    listeners,
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    close: vi.fn(),
    readyState: 1,
    emit(type: string, data: string) {
      for (const listener of listeners.get(type) ?? []) {
        listener({ data });
      }
    },
  };

  const fetchMock = vi.fn();
  const createEventSourceMock = vi.fn().mockReturnValue(mockEventSource);

  return {
    md5,
    createEventSource: createEventSourceMock,
    fetch: fetchMock,
    mockEventSource,
    fetchMock,
    createEventSourceMock,
    sseSupportsHeaders: opts?.sseSupportsHeaders,
  };
}

describe('FeatureflipClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await FeatureflipClient.resetForTesting();
  });

  describe('waitForInitialization', () => {
    it('fetches flags and becomes initialized', async () => {
      const platform = createMockPlatform();
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makeFlagResponse(),
      });

      const client = FeatureflipClient.get(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
        platform,
      );

      expect(client.isInitialized).toBe(false);
      await client.waitForInitialization();
      expect(client.isInitialized).toBe(true);

      await client.close();
    });

    it('does not reject on fetch failure and serves defaults', async () => {
      const platform = createMockPlatform();
      platform.fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const client = FeatureflipClient.get(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
        platform,
      );

      // A failed initial fetch must not reject initialize() — the client
      // stays degraded-but-recovering rather than serving defaults forever.
      await expect(client.waitForInitialization()).resolves.toBeUndefined();
      expect(client.isInitialized).toBe(true);
      expect(client.boolVariation('bool-flag', {}, false)).toBe(false);

      await client.close();
    });

    it('does not reject on timeout and serves defaults', async () => {
      const platform = createMockPlatform();
      // Model a real fetch: stays pending until its AbortSignal fires (the
      // initTimeout), then rejects — nothing else ever resolves it.
      platform.fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('Aborted')),
          );
        });
      });

      const client = FeatureflipClient.get(
        {
          sdkKey: 'test-key',
          baseUrl: 'http://localhost:5000',
          initTimeout: 1000,
        },
        platform,
      );

      const initPromise = client.waitForInitialization();
      await vi.advanceTimersByTimeAsync(1001); // fire the init timeout

      // A timed-out initial fetch must not reject initialize() — the client is
      // ready in a degraded-but-recovering state and serves caller defaults.
      await expect(initPromise).resolves.toBeUndefined();
      expect(client.isInitialized).toBe(true);
      expect(client.boolVariation('bool-flag', {}, false)).toBe(false);

      // Let the event flush triggered by close() complete (it reuses the fetch mock).
      platform.fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
      await client.close();
    });

    it('aborts the initial fetch when initTimeout fires so the socket is released', async () => {
      const platform = createMockPlatform();
      let capturedSignal: AbortSignal | undefined;
      // Model a real fetch: it stays pending until its AbortSignal fires, then rejects.
      platform.fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('Aborted')),
          );
        });
      });

      const client = FeatureflipClient.get(
        {
          sdkKey: 'test-key',
          baseUrl: 'http://localhost:5000',
          initTimeout: 1000,
        },
        platform,
      );

      const initPromise = client.waitForInitialization();
      await vi.advanceTimersByTimeAsync(1001); // fire the init timeout

      // initialize() still resolves degraded...
      await expect(initPromise).resolves.toBeUndefined();
      expect(client.isInitialized).toBe(true);
      // ...and the initial request was actually cancelled, not left running.
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(true);

      platform.fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
      await client.close();
    });
  });

  describe('variations', () => {
    let client: FeatureflipClient;
    let platform: ReturnType<typeof createMockPlatform>;

    beforeEach(async () => {
      platform = createMockPlatform();
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makeFlagResponse(),
      });

      client = FeatureflipClient.get(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
        platform,
      );
      await client.waitForInitialization();
    });

    afterEach(async () => {
      await client.close();
    });

    it('boolVariation returns flag value', () => {
      expect(client.boolVariation('bool-flag', { user_id: '1' }, false)).toBe(
        true,
      );
    });

    it('boolVariation returns default for unknown flag', () => {
      expect(
        client.boolVariation('unknown', { user_id: '1' }, false),
      ).toBe(false);
    });

    it('stringVariation returns flag value', () => {
      expect(
        client.stringVariation('string-flag', { user_id: '1' }, 'default'),
      ).toBe('alpha');
    });

    it('returns offVariation for disabled flag', () => {
      expect(
        client.boolVariation('disabled-flag', { user_id: '1' }, true),
      ).toBe(false);
    });

    it('variationDetail includes reason', () => {
      const detail = client.variationDetail(
        'bool-flag',
        { user_id: '1' },
        false,
      );
      expect(detail.value).toBe(true);
      expect(detail.reason).toBe('Fallthrough');
    });

    it('variationDetail includes variationKey', () => {
      const detail = client.variationDetail(
        'bool-flag',
        { user_id: '1' },
        false,
      );
      expect(detail.variationKey).toBe('on');
    });

    it('variationDetail returns FlagNotFound for unknown', () => {
      const detail = client.variationDetail(
        'unknown',
        { user_id: '1' },
        false,
      );
      expect(detail.value).toBe(false);
      expect(detail.reason).toBe('FlagNotFound');
    });
  });

  describe('track', () => {
    it('enqueues a custom event', async () => {
      const platform = createMockPlatform();
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makeFlagResponse(),
      });

      const client = FeatureflipClient.get(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
        platform,
      );
      await client.waitForInitialization();

      client.track('purchase', { user_id: 'u1' }, { amount: 42 });

      // Close flushes events
      await client.close();

      // Find the events POST call
      const eventsCalls = platform.fetchMock.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('/v1/sdk/events'),
      );
      expect(eventsCalls.length).toBeGreaterThan(0);
    });
  });

  describe('identify', () => {
    it('enqueues an identify event', async () => {
      const platform = createMockPlatform();
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makeFlagResponse(),
      });

      const client = FeatureflipClient.get(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
        platform,
      );
      await client.waitForInitialization();

      client.identify({ user_id: 'u1', plan: 'pro' });

      await client.close();

      const eventsCalls = platform.fetchMock.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('/v1/sdk/events'),
      );
      expect(eventsCalls.length).toBeGreaterThan(0);

      const body = JSON.parse(
        (eventsCalls[0] as [string, RequestInit])[1].body as string,
      );
      expect(body.events[0].type).toBe('Identify');
      expect(body.events[0].userId).toBe('u1');
      expect(body.events[0].metadata).toEqual({ plan: 'pro' });
    });
  });

  describe('evaluation events', () => {
    // A flag gated behind a disabled prerequisite: `flag-off` is disabled, so it
    // serves `off`, which does not match the expected `on` — `flag-prereq`
    // resolves PrerequisiteFailed with prerequisiteKey `flag-off`.
    function makePrereqResponse(): GetFlagsResponse {
      return {
        environment: 'test',
        version: 1,
        flags: [
          {
            key: 'flag-off',
            version: 1,
            type: 'Boolean',
            enabled: false,
            variations: [
              { key: 'on', value: true },
              { key: 'off', value: false },
            ],
            rules: [],
            fallthrough: { type: 'Fixed', variation: 'on' },
            offVariation: 'off',
          },
          {
            key: 'flag-prereq',
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
            prerequisites: [
              { prerequisiteFlagKey: 'flag-off', expectedVariationKey: 'on' },
            ],
          },
        ],
        segments: [],
      };
    }

    function eventsBodies(fetchMock: ReturnType<typeof vi.fn>) {
      return fetchMock.mock.calls
        .filter(
          (call: unknown[]) =>
            typeof call[0] === 'string' &&
            (call[0] as string).includes('/v1/sdk/events'),
        )
        .flatMap(
          (call) =>
            JSON.parse((call as [string, RequestInit])[1].body as string)
              .events as Record<string, unknown>[],
        );
    }

    it('records prerequisiteKey on the PrerequisiteFailed path', async () => {
      const platform = createMockPlatform();
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makePrereqResponse(),
      });

      const client = FeatureflipClient.get(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
        platform,
      );
      await client.waitForInitialization();

      expect(client.boolVariation('flag-prereq', { user_id: 'u1' }, false)).toBe(
        false,
      );
      await client.close();

      const evalEvents = eventsBodies(platform.fetchMock).filter(
        (e) => e.type === 'Evaluation',
      );
      expect(evalEvents).toHaveLength(1);
      expect(evalEvents[0].flagKey).toBe('flag-prereq');
      expect(evalEvents[0].variation).toBe('off');
      expect(evalEvents[0].prerequisiteKey).toBe('flag-off');
    });

    it('omits prerequisiteKey when the flag does not fail a prerequisite', async () => {
      const platform = createMockPlatform();
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makeFlagResponse(),
      });

      const client = FeatureflipClient.get(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
        platform,
      );
      await client.waitForInitialization();

      expect(client.boolVariation('bool-flag', { user_id: 'u1' }, false)).toBe(
        true,
      );
      await client.close();

      const evalEvents = eventsBodies(platform.fetchMock).filter(
        (e) => e.type === 'Evaluation',
      );
      expect(evalEvents).toHaveLength(1);
      // Absent, not null — the server omits null optionals on the wire and the
      // JS SDK must not send `prerequisiteKey: null` for a non-prereq event.
      expect('prerequisiteKey' in evalEvents[0]).toBe(false);
    });
  });

  describe('flush', () => {
    it('sends pending events immediately', async () => {
      const platform = createMockPlatform();
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makeFlagResponse(),
      });

      const client = FeatureflipClient.get(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
        platform,
      );
      await client.waitForInitialization();

      client.track('purchase', { user_id: 'u1' });
      await client.flush();

      const eventsCalls = platform.fetchMock.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('/v1/sdk/events'),
      );
      expect(eventsCalls.length).toBeGreaterThan(0);

      await client.close();
    });
  });

  describe('forTesting', () => {
    it('creates a client with hardcoded values', () => {
      const client = FeatureflipClient.forTesting({
        'my-flag': true,
        'my-string': 'hello',
        'my-number': 42,
      });

      expect(client.isInitialized).toBe(true);
      expect(client.boolVariation('my-flag', {}, false)).toBe(true);
      expect(client.stringVariation('my-string', {}, '')).toBe('hello');
      expect(client.numberVariation('my-number', {}, 0)).toBe(42);
      expect(client.boolVariation('unknown', {}, false)).toBe(false);
    });
  });

  describe('prerequisites', () => {
    function makePrereqFlagResponse(prereqEnabled: boolean): GetFlagsResponse {
      return {
        environment: 'test',
        version: 1,
        flags: [
          {
            key: 'prereq-flag',
            version: 1,
            type: 'Boolean',
            enabled: prereqEnabled,
            variations: [
              { key: 'on', value: true },
              { key: 'off', value: false },
            ],
            rules: [],
            fallthrough: { type: 'Fixed', variation: 'on' },
            offVariation: 'off',
          },
          {
            key: 'dependent-flag',
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
            prerequisites: [
              { prerequisiteFlagKey: 'prereq-flag', expectedVariationKey: 'on' },
            ],
          },
        ],
        segments: [],
      };
    }

    it('serves dependent flag normally when prerequisite is satisfied', async () => {
      const platform = createMockPlatform();
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makePrereqFlagResponse(true),
      });

      const client = FeatureflipClient.get(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
        platform,
      );
      await client.waitForInitialization();

      const detail = client.variationDetail(
        'dependent-flag',
        { user_id: '1' },
        false,
      );
      expect(detail.value).toBe(true);
      expect(detail.reason).toBe('Fallthrough');
      expect(detail.prerequisiteKey).toBeUndefined();

      await client.close();
    });

    it('serves off variation and surfaces prerequisiteKey when prereq fails', async () => {
      const platform = createMockPlatform();
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makePrereqFlagResponse(false), // prereq disabled -> 'off'
      });

      const client = FeatureflipClient.get(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
        platform,
      );
      await client.waitForInitialization();

      const detail = client.variationDetail(
        'dependent-flag',
        { user_id: '1' },
        true,
      );
      expect(detail.value).toBe(false);
      expect(detail.reason).toBe('PrerequisiteFailed');
      expect(detail.prerequisiteKey).toBe('prereq-flag');

      await client.close();
    });

    it('serves default when prerequisite flag is missing from snapshot', async () => {
      const platform = createMockPlatform();
      const response: GetFlagsResponse = {
        environment: 'test',
        version: 1,
        flags: [
          {
            key: 'dependent-flag',
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
            prerequisites: [
              { prerequisiteFlagKey: 'missing-prereq', expectedVariationKey: 'on' },
            ],
          },
        ],
        segments: [],
      };
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => response,
      });

      const client = FeatureflipClient.get(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
        platform,
      );
      await client.waitForInitialization();

      const detail = client.variationDetail(
        'dependent-flag',
        { user_id: '1' },
        true,
      );
      expect(detail.value).toBe(false);
      expect(detail.reason).toBe('PrerequisiteFailed');
      expect(detail.prerequisiteKey).toBe('missing-prereq');

      await client.close();
    });
  });

  describe('streaming updates', () => {
    it('fetches updated flag on SSE event', async () => {
      // Use real timers for this test since it relies on async fetch resolution
      vi.useRealTimers();

      const platform = createMockPlatform();

      const updatedFlag: FlagDto = {
        key: 'bool-flag',
        version: 2,
        type: 'Boolean',
        enabled: false,
        variations: [
          { key: 'on', value: true },
          { key: 'off', value: false },
        ],
        rules: [],
        fallthrough: { type: 'Fixed', variation: 'on' },
        offVariation: 'off',
      };

      platform.fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/v1/sdk/flags/bool-flag')) {
          return { ok: true, json: async () => updatedFlag };
        }
        if (url.includes('/v1/sdk/flags')) {
          return { ok: true, json: async () => makeFlagResponse() };
        }
        // events endpoint
        return { ok: true };
      });

      const client = FeatureflipClient.get(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true },
        platform,
      );
      await client.waitForInitialization();

      // Initially on
      expect(client.boolVariation('bool-flag', {}, false)).toBe(true);

      // Simulate SSE event
      platform.mockEventSource.emit(
        'flag.updated',
        JSON.stringify({ key: 'bool-flag', version: 2 }),
      );

      // Wait for the async fetch to complete
      await new Promise((r) => setTimeout(r, 50));

      // After update, flag is disabled -> returns off variation
      expect(client.boolVariation('bool-flag', {}, true)).toBe(false);

      await client.close();
    });

    it('does not include SDK key in URL when platform supports SSE headers', async () => {
      vi.useRealTimers();

      const platform = createMockPlatform({ sseSupportsHeaders: true });
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makeFlagResponse(),
      });

      const client = FeatureflipClient.get(
        { sdkKey: 'secret-key', baseUrl: 'http://localhost:5000', streaming: true },
        platform,
      );
      await client.waitForInitialization();

      const url = platform.createEventSourceMock.mock.calls[0]?.[0] as string;
      expect(url).toBe('http://localhost:5000/v1/sdk/stream');
      expect(url).not.toContain('secret-key');

      await client.close();
    });

    it('includes SDK key in URL query param when platform does not support SSE headers', async () => {
      vi.useRealTimers();

      const platform = createMockPlatform({ sseSupportsHeaders: false });
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makeFlagResponse(),
      });

      const client = FeatureflipClient.get(
        { sdkKey: 'client-key', baseUrl: 'http://localhost:5000', streaming: true },
        platform,
      );
      await client.waitForInitialization();

      const url = platform.createEventSourceMock.mock.calls[0]?.[0] as string;
      expect(url).toContain('authorization=client-key');

      await client.close();
    });
  });
});
