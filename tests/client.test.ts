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

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('waitForInitialization', () => {
    it('fetches flags and becomes initialized', async () => {
      const platform = createMockPlatform();
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makeFlagResponse(),
      });

      const client = new FeatureflipClient(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
        platform,
      );

      expect(client.isInitialized).toBe(false);
      await client.waitForInitialization();
      expect(client.isInitialized).toBe(true);

      await client.close();
    });

    it('rejects on fetch failure', async () => {
      const platform = createMockPlatform();
      platform.fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const client = new FeatureflipClient(
        { sdkKey: 'test-key', baseUrl: 'http://localhost:5000' },
        platform,
      );

      await expect(client.waitForInitialization()).rejects.toThrow(
        'Failed to fetch flags: 500',
      );

      await client.close();
    });

    it('rejects on timeout', async () => {
      const platform = createMockPlatform();
      platform.fetchMock.mockImplementation(
        () => new Promise(() => {}), // Never resolves
      );

      const client = new FeatureflipClient(
        {
          sdkKey: 'test-key',
          baseUrl: 'http://localhost:5000',
          initTimeout: 1000,
        },
        platform,
      );

      const initPromise = client.waitForInitialization().catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(1001);
      const result = await initPromise;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Initialization timed out');

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

      client = new FeatureflipClient(
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

      const client = new FeatureflipClient(
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

      const client = new FeatureflipClient(
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

  describe('flush', () => {
    it('sends pending events immediately', async () => {
      const platform = createMockPlatform();
      platform.fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makeFlagResponse(),
      });

      const client = new FeatureflipClient(
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

      const client = new FeatureflipClient(
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

      const client = new FeatureflipClient(
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

      const client = new FeatureflipClient(
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
