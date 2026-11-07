import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SharedFeatureflipCore } from '../../src/core/shared-core.js';
import type { Platform, EventSourceLike } from '../../src/platform/types.js';
import type { FlagDto, GetFlagsResponse } from '../../src/core/types.js';
import { computeKeyHash, type SnapshotStore } from '../../src/core/snapshot-store.js';
import { FileSnapshotStore } from '../../src/platform/file-snapshot-store.js';

function makeFlag(key: string, on = true, version = 1): FlagDto {
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
    fallthrough: { type: 'Fixed', variation: on ? 'on' : 'off' },
    offVariation: 'off',
  };
}

function makeResponse(flags: FlagDto[], version = 1): GetFlagsResponse {
  return { environment: 'test', version, flags, segments: [] };
}

const sha256Hex = (i: string) => createHash('sha256').update(i, 'utf8').digest('hex');
const hashFor = (baseUrl: string, sdkKey: string) => computeKeyHash(sha256Hex, baseUrl, sdkKey);

interface Envelope {
  v: number;
  keyHash: string;
  fetchedAt: number;
  data: GetFlagsResponse;
}

/** Stored text the way the core writes it, for key 'k' at 'http://x' unless overridden. */
function envelope(
  flags: FlagDto[],
  ageMs = 5000,
  over: Partial<{ v: number; sdkKey: string; baseUrl: string; fetchedAt: number }> = {},
): string {
  return JSON.stringify({
    v: over.v ?? 1,
    keyHash: hashFor(over.baseUrl ?? 'http://x', over.sdkKey ?? 'k'),
    fetchedAt: over.fetchedAt ?? Date.now() - ageMs,
    data: makeResponse(flags),
  });
}

const parse = (text: string | undefined) => JSON.parse(text!) as Envelope;

type MockES = EventSourceLike & { emit: (type: string, data?: string) => void };

function createPlatform(withSha = true) {
  const sources: MockES[] = [];
  const fetchMock = vi.fn();
  const platform: Platform = {
    md5: (i) => createHash('md5').update(i, 'utf8').digest(),
    sha256Hex: withSha ? sha256Hex : undefined,
    createEventSource: () => {
      const listeners = new Map<string, ((e: { data: string }) => void)[]>();
      const es: MockES = {
        addEventListener(t: string, l: (e: { data: string }) => void) {
          listeners.set(t, [...(listeners.get(t) ?? []), l]);
        },
        close: vi.fn(),
        readyState: 1,
        emit(t, d) {
          for (const l of listeners.get(t) ?? []) l({ data: d ?? '' });
        },
      };
      sources.push(es);
      return es;
    },
    fetch: fetchMock as unknown as Platform['fetch'],
  };
  return { platform, sources, fetchMock };
}

/** A custom opaque text store: no bind, no parsing. */
function memoryStore(initial?: string) {
  const store = {
    text: initial,
    get: vi.fn(async () => store.text),
    put: vi.fn(async (t: string) => {
      store.text = t;
    }),
  };
  return store satisfies SnapshotStore & Record<string, unknown>;
}

const okFetch = (flags: FlagDto[], version = 1) => ({
  ok: true,
  status: 200,
  json: async () => makeResponse(flags, version),
});

describe('snapshot startup', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  const cores: SharedFeatureflipCore[] = [];
  let dir: string;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-core-snap-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const c of cores.splice(0)) await c.release();
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function make(
    p: ReturnType<typeof createPlatform>,
    store?: SnapshotStore,
    extra: Record<string, unknown> = {},
  ) {
    const core = new SharedFeatureflipCore(
      {
        sdkKey: 'k',
        baseUrl: 'http://x',
        streaming: false,
        pollInterval: 1000,
        snapshotStore: store,
        ...extra,
      },
      p.platform,
    );
    cores.push(core);
    return core;
  }

  const warned = (text: string) => warn.mock.calls.some((c) => c.map(String).join(' ').includes(text));

  it('persists a healthy start as live, in the SDK-owned envelope', async () => {
    const p = createPlatform();
    p.fetchMock.mockResolvedValue(okFetch([makeFlag('a')]));
    const store = memoryStore();
    const core = make(p, store);
    await core.waitForInitialization();
    expect(core.startupInfo).toEqual({ source: 'live' });
    expect(store.put).toHaveBeenCalledOnce();
    const env = parse(store.put.mock.calls[0][0]);
    expect(env.v).toBe(1);
    expect(env.keyHash).toBe(hashFor('http://x', 'k'));
    expect(env.data.flags.map((f) => f.key)).toEqual(['a']);
    expect(env.data.environment).toBe('test');
    expect(Number.isInteger(env.fetchedAt)).toBe(true);
    expect(Math.abs(env.fetchedAt - Date.now())).toBeLessThan(2000);
    expect(store.put.mock.calls[0][0]).not.toContain('"k"');
    expect(store.get).not.toHaveBeenCalled();
  });

  it('serves the snapshot when the fetch rejects', async () => {
    const p = createPlatform();
    p.fetchMock.mockRejectedValue(new Error('down'));
    const store = memoryStore(envelope([makeFlag('a')], 5000));
    const core = make(p, store);
    await core.waitForInitialization();
    expect(core.isInitialized).toBe(true);
    expect(core.evaluateFlag('a', {}, false)).toBe(true);
    const info = core.startupInfo;
    expect(info.source).toBe('snapshot');
    expect(info.reason).toBe('snapshot');
    expect(info.snapshotAgeSeconds).toBeGreaterThanOrEqual(5);
    expect(info.snapshotAgeSeconds).toBeLessThan(10);
  });

  it('a custom text store with no bind round trips between two cores', async () => {
    const store = memoryStore();
    const up = createPlatform();
    up.fetchMock.mockResolvedValue(okFetch([makeFlag('a')]));
    await make(up, store).waitForInitialization();
    await vi.waitFor(() => expect(store.text).toBeDefined());

    const down = createPlatform();
    down.fetchMock.mockRejectedValue(new Error('down'));
    const core = make(down, store);
    await core.waitForInitialization();
    expect(core.startupInfo.source).toBe('snapshot');
    expect(core.evaluateFlag('a', {}, false)).toBe(true);
  });

  it('does not refresh fetchedAt by loading a snapshot', async () => {
    const p = createPlatform();
    p.fetchMock.mockRejectedValue(new Error('down'));
    const store = memoryStore(envelope([makeFlag('a')]));
    await make(p, store).waitForInitialization();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('falls back when initTimeout aborts the fetch, and says it timed out', async () => {
    vi.useFakeTimers();
    const p = createPlatform();
    p.fetchMock.mockImplementation(
      (u: string, init?: { signal?: AbortSignal }) =>
        !u.endsWith('/v1/sdk/flags')
          ? Promise.resolve({ ok: true })
          : new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
        }),
    );
    const store = memoryStore(envelope([makeFlag('a')]));
    const core = make(p, store, { initTimeout: 500 });
    const ready = core.waitForInitialization();
    await vi.advanceTimersByTimeAsync(600);
    await ready;
    expect(core.evaluateFlag('a', {}, false)).toBe(true);
    expect(core.startupInfo.source).toBe('snapshot');
    expect(warned('timed out after 500ms')).toBe(true);
  });

  it('names the fetch failure so a revoked key differs from an unreachable host', async () => {
    const run = async (fetchResult: () => Promise<unknown>) => {
      warn.mockClear();
      const p = createPlatform();
      p.fetchMock.mockImplementation(fetchResult);
      const core = make(p, memoryStore(envelope([makeFlag('a')])));
      await core.waitForInitialization();
      expect(core.startupInfo.source).toBe('snapshot');
      return warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    };
    const unauthorized = await run(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const unreachable = await run(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1');
    });
    expect(unauthorized).toContain('HTTP 401');
    expect(unauthorized).not.toContain('ECONNREFUSED');
    expect(unreachable).toContain('ECONNREFUSED');
    expect(unreachable).not.toContain('HTTP 401');
    expect(unreachable).toContain('serving persisted snapshot');
  });

  it('ignores an expired snapshot and warns', async () => {
    const p = createPlatform();
    p.fetchMock.mockRejectedValue(new Error('down'));
    const store = memoryStore(envelope([makeFlag('a')], 100_000));
    const core = make(p, store, { maxSnapshotAgeSeconds: 10 });
    await core.waitForInitialization();
    expect(core.evaluateFlag('a', {}, false)).toBe(false);
    expect(core.startupInfo.source).toBe('none');
    expect(core.startupInfo.reason).toBe('snapshot-expired');
    expect(warned('snapshot-expired')).toBe(true);
  });

  it.each([
    ['unparseable text', () => 'not json{'],
    ['data failing validation', () =>
      JSON.stringify({ v: 1, keyHash: hashFor('http://x', 'k'), fetchedAt: Date.now() - 1000, data: { environment: 'x' } })],
    ['a fetchedAt 61s in the future', () => envelope([makeFlag('a')], 0, { fetchedAt: Date.now() + 61_000 })],
    ['a zero fetchedAt', () => envelope([makeFlag('a')], 0, { fetchedAt: 0 })],
    ['another SDK key', () => envelope([makeFlag('a')], 1000, { sdkKey: 'other' })],
    ['a v:2 envelope', () => envelope([makeFlag('a')], 1000, { v: 2 })],
  ])('a custom store holding %s is snapshot-invalid', async (_n, text) => {
    const p = createPlatform();
    p.fetchMock.mockRejectedValue(new Error('down'));
    const core = make(p, memoryStore(text()));
    await core.waitForInitialization();
    expect(core.startupInfo).toEqual({ source: 'none', reason: 'snapshot-invalid' });
    expect(core.evaluateFlag('a', {}, false)).toBe(false);
    expect(warned('snapshot-invalid')).toBe(true);
  });

  it('a store returning a non-string is snapshot-invalid', async () => {
    const p = createPlatform();
    p.fetchMock.mockRejectedValue(new Error('down'));
    const store = {
      get: async () => ({ data: makeResponse([makeFlag('a')]), fetchedAt: Date.now() }),
      put: async () => {},
    } as unknown as SnapshotStore;
    const core = make(p, store);
    await core.waitForInitialization();
    expect(core.startupInfo).toEqual({ source: 'none', reason: 'snapshot-invalid' });
    expect(warned('non-string')).toBe(true);
  });

  it('tolerates 60s of clock skew (age 0) and rejects 61s', async () => {
    const now = 1_800_000_000_000;
    vi.useFakeTimers({ toFake: ['Date'], now });
    for (const [skew, expected] of [
      [60_000, { source: 'snapshot', reason: 'snapshot', snapshotAgeSeconds: 0 }],
      [61_000, { source: 'none', reason: 'snapshot-invalid' }],
    ] as const) {
      const p = createPlatform();
      p.fetchMock.mockRejectedValue(new Error('down'));
      const core = make(p, memoryStore(envelope([makeFlag('a')], 0, { fetchedAt: now + skew })));
      await core.waitForInitialization();
      expect(core.startupInfo).toEqual(expected);
    }
  });

  describe('through the real FileSnapshotStore', () => {
    const file = () => path.join(dir, 'snap.json');

    async function writeLive(sdkKey: string, baseUrl: string, flags: FlagDto[], store?: SnapshotStore) {
      const p = createPlatform();
      p.fetchMock.mockResolvedValue(okFetch(flags));
      const s = store ?? new FileSnapshotStore(file());
      const core = make(p, s, { sdkKey, baseUrl });
      await core.waitForInitialization();
      await vi.waitFor(() => expect(fs.existsSync(file())).toBe(true));
      return core;
    }

    async function startDown(extra: Record<string, unknown> = {}, store?: SnapshotStore) {
      const p = createPlatform();
      p.fetchMock.mockRejectedValue(new Error('down'));
      const core = make(p, store ?? new FileSnapshotStore(file()), extra);
      await core.waitForInitialization();
      return core;
    }

    it('serves a snapshot it wrote itself', async () => {
      await writeLive('k', 'http://x', [makeFlag('a')]);
      const core = await startDown();
      expect(core.startupInfo.source).toBe('snapshot');
      expect(core.evaluateFlag('a', {}, false)).toBe(true);
    });

    it.each([
      ['a garbage file', () => fs.writeFileSync(file(), 'not json{')],
      ['a zero-length file', () => fs.writeFileSync(file(), '')],
      ['a truncated file', () => fs.writeFileSync(file(), envelope([makeFlag('a')]).slice(0, 40))],
      ['a v:2 envelope', () => fs.writeFileSync(file(), envelope([makeFlag('a')], 1000, { v: 2 }))],
      ['a future fetchedAt', () =>
        fs.writeFileSync(file(), envelope([makeFlag('a')], 0, { fetchedAt: Date.now() + 3_600_000 }))],
      ['a file written by a different SDK key', () => writeLive('other-key', 'http://x', [makeFlag('a')])],
      ['a file written for a different baseUrl', () => writeLive('k', 'http://elsewhere', [makeFlag('a')])],
    ])('%s gives snapshot-invalid and defaults', async (_n, setup) => {
      await setup();
      warn.mockClear();
      const core = await startDown();
      expect(core.startupInfo).toEqual({ source: 'none', reason: 'snapshot-invalid' });
      expect(core.evaluateFlag('a', {}, false)).toBe(false);
      expect(warned('snapshot-invalid')).toBe(true);
    });

    it('one store instance shared by two SDK keys never crosses environments', async () => {
      const shared = new FileSnapshotStore(file());
      await writeLive('key-a', 'http://x', [makeFlag('only-a')], shared);
      const b = await startDown({ sdkKey: 'key-b' }, shared);
      expect(b.startupInfo).toEqual({ source: 'none', reason: 'snapshot-invalid' });
      expect(b.evaluateFlag('only-a', {}, false)).toBe(false);

      fs.rmSync(file());
      await writeLive('key-b', 'http://x', [makeFlag('only-b')], shared);
      const a = await startDown({ sdkKey: 'key-a' }, shared);
      expect(a.startupInfo).toEqual({ source: 'none', reason: 'snapshot-invalid' });
      expect(a.evaluateFlag('only-b', {}, false)).toBe(false);
    });

    it('a missing file is a plain miss with no reason', async () => {
      const core = await startDown();
      expect(core.startupInfo).toEqual({ source: 'none' });
    });

    it('an unreadable path (a directory) is a plain miss with a warning', async () => {
      const core = await startDown({}, new FileSnapshotStore(dir));
      expect(core.startupInfo).toEqual({ source: 'none' });
      expect(warned('could not read snapshot file')).toBe(true);
    });
  });

  it('a hung store get times out at initTimeout, init completes and the data source starts', async () => {
    vi.useFakeTimers();
    const p = createPlatform();
    p.fetchMock.mockImplementation((u: string) =>
      u.endsWith('/v1/sdk/flags') ? Promise.reject(new Error('down')) : Promise.resolve({ ok: true }),
    );
    const store: SnapshotStore = { get: () => new Promise(() => {}), put: async () => {} };
    const core = make(p, store, { initTimeout: 500, streaming: true });
    const ready = core.waitForInitialization();
    await vi.advanceTimersByTimeAsync(600);
    await ready;
    expect(core.isInitialized).toBe(true);
    expect(core.evaluateFlag('a', {}, false)).toBe(false);
    expect(core.startupInfo).toEqual({ source: 'none' });
    expect(p.sources).toHaveLength(1);
    expect(warned('snapshot store read timed out')).toBe(true);
  });

  it('a late get result is ignored', async () => {
    vi.useFakeTimers();
    const p = createPlatform();
    p.fetchMock.mockImplementation((u: string) =>
      u.endsWith('/v1/sdk/flags') ? Promise.reject(new Error('down')) : Promise.resolve({ ok: true }),
    );
    let resolveGet!: (s: string) => void;
    const store: SnapshotStore = {
      get: () => new Promise((r) => (resolveGet = r)),
      put: async () => {},
    };
    const core = make(p, store, { initTimeout: 500 });
    const ready = core.waitForInitialization();
    await vi.advanceTimersByTimeAsync(600);
    await ready;
    resolveGet(envelope([makeFlag('a')]));
    await vi.advanceTimersByTimeAsync(10);
    expect(core.evaluateFlag('a', {}, false)).toBe(false);
    expect(core.startupInfo.source).toBe('none');
  });

  it('single-flag updates do not persist before a full live apply, and do after', async () => {
    const p = createPlatform();
    p.fetchMock.mockImplementation((u: string) =>
      u.endsWith('/v1/sdk/flags')
        ? Promise.reject(new Error('down'))
        : Promise.resolve({ ok: true, json: async () => makeFlag('a', false, 9) }),
    );
    const store = memoryStore(envelope([makeFlag('a'), makeFlag('b')]));
    const core = make(p, store, { streaming: true });
    await core.waitForInitialization();
    expect(core.startupInfo.source).toBe('snapshot');
    const es = p.sources[0];

    es.emit('flag.updated', JSON.stringify({ key: 'a' }));
    es.emit('flag.deleted', JSON.stringify({ key: 'b' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(store.put).not.toHaveBeenCalled();

    es.emit('sync', JSON.stringify(makeResponse([makeFlag('a'), makeFlag('b')], 3)));
    await vi.waitFor(() => expect(store.put).toHaveBeenCalledTimes(1));
    es.emit('flag.updated', JSON.stringify({ key: 'a' }));
    await vi.waitFor(() => expect(store.put).toHaveBeenCalledTimes(2));
    const snap = parse(store.text).data;
    expect(snap.flags.map((f) => f.key).sort()).toEqual(['a', 'b']);
    expect(snap.flags.find((f) => f.key === 'a')!.fallthrough.variation).toBe('off');
  });

  it('survives a store whose get throws, rejects, and whose put rejects', async () => {
    const throwing = {
      get: () => {
        throw new Error('sync boom');
      },
      put: async () => {},
    } as unknown as SnapshotStore;
    const rejecting: SnapshotStore = {
      get: async () => {
        throw new Error('async boom');
      },
      put: async () => {},
    };
    for (const s of [throwing, rejecting]) {
      const p = createPlatform();
      p.fetchMock.mockRejectedValue(new Error('down'));
      const core = make(p, s);
      await core.waitForInitialization();
      expect(core.isInitialized).toBe(true);
      expect(core.startupInfo.source).toBe('none');
    }
    expect(warned('snapshot store read failed')).toBe(true);

    const badPut: SnapshotStore = {
      get: async () => undefined,
      put: async () => {
        throw new Error('disk full');
      },
    };
    const p = createPlatform();
    p.fetchMock.mockResolvedValue(okFetch([makeFlag('a')]));
    const core = make(p, badPut);
    await core.waitForInitialization();
    await vi.waitFor(() => expect(warned('snapshot store write failed')).toBe(true));
    expect(core.startupInfo.source).toBe('live');
  });

  it('replaces the snapshot with live data on the next poll and persists it', async () => {
    vi.useFakeTimers();
    const p = createPlatform();
    p.fetchMock.mockRejectedValueOnce(new Error('down'));
    const store = memoryStore(envelope([makeFlag('a', true)]));
    const core = make(p, store);
    await core.waitForInitialization();
    expect(core.startupInfo.source).toBe('snapshot');
    p.fetchMock.mockResolvedValue(okFetch([makeFlag('a', false, 2)]));
    await vi.advanceTimersByTimeAsync(1100);
    expect(core.evaluateFlag('a', {}, true)).toBe(false);
    expect(core.startupInfo).toEqual({ source: 'live' });
    expect(store.put).toHaveBeenCalledOnce();
    expect(parse(store.put.mock.calls[0][0]).data.flags[0].fallthrough.variation).toBe('off');
  });

  it('a snapshot start recovering to identical live data still rewrites with a fresh fetchedAt', async () => {
    vi.useFakeTimers();
    const p = createPlatform();
    p.fetchMock.mockRejectedValueOnce(new Error('down'));
    const store = memoryStore(envelope([makeFlag('a')], 60_000));
    const core = make(p, store);
    await core.waitForInitialization();
    p.fetchMock.mockResolvedValue(okFetch([makeFlag('a')]));
    await vi.advanceTimersByTimeAsync(1100);
    expect(core.startupInfo).toEqual({ source: 'live' });
    expect(store.put).toHaveBeenCalledOnce();
    expect(Date.now() - parse(store.text).fetchedAt).toBeLessThan(2000);
  });

  it('persists on SSE sync, single-flag update and delete with the merged state', async () => {
    const p = createPlatform();
    p.fetchMock.mockResolvedValue(okFetch([makeFlag('a'), makeFlag('b')]));
    const store = memoryStore();
    const core = make(p, store, { streaming: true });
    await core.waitForInitialization();
    await vi.waitFor(() => expect(store.put).toHaveBeenCalledTimes(1));
    const es = p.sources[0];

    es.emit('sync', JSON.stringify(makeResponse([makeFlag('a'), makeFlag('b'), makeFlag('c')], 5)));
    await vi.waitFor(() => expect(store.put).toHaveBeenCalledTimes(2));
    expect(parse(store.text).data.flags.map((f) => f.key).sort()).toEqual(['a', 'b', 'c']);
    expect(parse(store.text).data.version).toBe(5);

    p.fetchMock.mockResolvedValue({ ok: true, json: async () => makeFlag('a', false, 9) });
    es.emit('flag.updated', JSON.stringify({ key: 'a' }));
    await vi.waitFor(() => expect(store.put).toHaveBeenCalledTimes(3));
    const a = parse(store.text).data.flags.find((f) => f.key === 'a')!;
    expect(a.fallthrough.variation).toBe('off');
    expect(parse(store.text).data.flags).toHaveLength(3);

    es.emit('flag.deleted', JSON.stringify({ key: 'b' }));
    await vi.waitFor(() => expect(store.put).toHaveBeenCalledTimes(4));
    expect(parse(store.text).data.flags.map((f) => f.key).sort()).toEqual(['a', 'c']);
  });

  it('coalesces writes: one in flight plus one trailing', async () => {
    const p = createPlatform();
    p.fetchMock.mockResolvedValue(okFetch([makeFlag('a')]));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const store: SnapshotStore = {
      get: async () => undefined,
      put: async (t) => {
        calls.push(t);
        if (calls.length === 1) await gate;
      },
    };
    const core = make(p, store, { streaming: true });
    await core.waitForInitialization();
    const es = p.sources[0];
    for (let v = 2; v <= 6; v++) es.emit('sync', JSON.stringify(makeResponse([makeFlag('a')], v)));
    expect(calls).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(parse(calls[1]).data.version).toBe(6);
  });

  describe('refreshing the stored timestamp while live', () => {
    const MIN = 60_000;

    it('a ping within 5 minutes of the last write does not write; after 5 minutes it does', async () => {
      vi.useFakeTimers();
      const p = createPlatform();
      p.fetchMock.mockResolvedValue(okFetch([makeFlag('a')]));
      const store = memoryStore();
      const core = make(p, store, { streaming: true });
      await core.waitForInitialization();
      expect(store.put).toHaveBeenCalledTimes(1);
      const first = parse(store.text).fetchedAt;
      const es = p.sources[0];

      await vi.advanceTimersByTimeAsync(4 * MIN);
      es.emit('ping', '{}');
      await vi.advanceTimersByTimeAsync(0);
      expect(store.put).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1 * MIN + 1000);
      es.emit('ping', '{}');
      await vi.advanceTimersByTimeAsync(0);
      expect(store.put).toHaveBeenCalledTimes(2);
      expect(parse(store.text).fetchedAt).toBeGreaterThanOrEqual(first + 5 * MIN);
      expect(parse(store.text).data.flags.map((f) => f.key)).toEqual(['a']);

      es.emit('ping', '{}');
      await vi.advanceTimersByTimeAsync(0);
      expect(store.put).toHaveBeenCalledTimes(2);
    });

    it('a snapshot-started client never refreshes on ping', async () => {
      vi.useFakeTimers();
      const p = createPlatform();
      p.fetchMock.mockImplementation((u: string) =>
        u.endsWith('/v1/sdk/flags') ? Promise.reject(new Error('down')) : Promise.resolve({ ok: true }),
      );
      const store = memoryStore(envelope([makeFlag('a')]));
      const core = make(p, store, { streaming: true });
      const ready = core.waitForInitialization();
      await vi.advanceTimersByTimeAsync(0);
      await ready;
      expect(core.startupInfo.source).toBe('snapshot');
      await vi.advanceTimersByTimeAsync(10 * MIN);
      p.sources[0].emit('ping', '{}');
      await vi.advanceTimersByTimeAsync(0);
      expect(store.put).not.toHaveBeenCalled();
    });

    it('polls: unchanged within 5 minutes skips, changed writes immediately, unchanged after 5 minutes refreshes', async () => {
      vi.useFakeTimers();
      const p = createPlatform();
      p.fetchMock.mockResolvedValue(okFetch([makeFlag('a')]));
      const store = memoryStore();
      const core = make(p, store, { pollInterval: 30_000 });
      await core.waitForInitialization();
      expect(store.put).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000); // unchanged poll at 0:30
      expect(store.put).toHaveBeenCalledTimes(1);

      p.fetchMock.mockResolvedValue(okFetch([makeFlag('a', false, 2)], 2));
      await vi.advanceTimersByTimeAsync(30_000); // changed poll at 1:00
      expect(store.put).toHaveBeenCalledTimes(2);
      expect(parse(store.text).data.version).toBe(2);
      const changedAt = parse(store.text).fetchedAt;

      await vi.advanceTimersByTimeAsync(4 * MIN); // unchanged polls through 5:00
      expect(store.put).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(MIN); // unchanged poll at 6:00, 5 min after the last write
      expect(store.put).toHaveBeenCalledTimes(3);
      expect(parse(store.text).fetchedAt - changedAt).toBeGreaterThanOrEqual(5 * MIN);
    });
  });

  it('a healthy start without a store is silent', async () => {
    const p = createPlatform(false);
    p.fetchMock.mockResolvedValue(okFetch([makeFlag('a')]));
    const core = make(p);
    await core.waitForInitialization();
    expect(core.startupInfo).toEqual({ source: 'live' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('throws a config error when a store is set but the platform has no sha256Hex', () => {
    const p = createPlatform(false);
    expect(() => make(p, memoryStore())).toThrow(/SHA-256/);
  });
});
