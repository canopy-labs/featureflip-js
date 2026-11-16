import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { FeatureflipClient } from '../src/client.js';
import { createRedactingWarn } from '../src/core/redacting-log.js';
import { buildIdentity } from '../src/core/identity.js';
import { SafeSnapshotStore } from '../src/core/snapshot-store.js';
import type { Platform, EventSourceLike } from '../src/platform/types.js';
import type { FlagDto } from '../src/core/types.js';

// #5167 / #5166: the SDK key is a credential, so it must never reach a log
// sink or an exception message, even when the fetch/EventSource implementation
// quotes the Authorization header in the error it throws.

const SERVER_KEY = 'sdk_server_SentinelKeyMustNeverAppearInLogs-0123456789';
const CLIENT_KEY = 'sdk_client_SentinelKeyMustNeverAppearInLogs-0123456789';

const flag: FlagDto = {
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
};

const okBody = { environment: 'test', version: 1, flags: [flag], segments: [] };

/** A transport error shaped like an HTTP stack that quotes the request headers. */
function leakyError(key: string): Error {
  const err = new Error(`request failed: GET /v1/sdk/flags headers={"Authorization":"${key}"}`);
  (err as { cause?: unknown }).cause = new Error(`socket hang up (Authorization: ${key})`);
  return err;
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function platform(key: string, fetchImpl: FetchImpl, esThrows = false): Platform {
  return {
    md5: () => new Uint8Array(16),
    fetch: fetchImpl,
    createEventSource: (): EventSourceLike => {
      if (esThrows) throw leakyError(key);
      return { addEventListener() {}, close() {}, readyState: 1 };
    },
  };
}

const json = (status: number, body: unknown = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

let captured: string[];
let spies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  captured = [];
  const sink = (...args: unknown[]) => {
    // inspect with unlimited depth renders messages, stacks and causes.
    captured.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: null }))).join(' '));
  };
  spies = (['log', 'info', 'debug', 'warn', 'error', 'trace'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(sink),
  );
});

afterEach(async () => {
  spies.forEach((s) => s.mockRestore());
  await FeatureflipClient.resetForTesting();
});

function expectClean(key: string, thrown: unknown[]) {
  const output = captured.join('\n');
  expect(output).not.toContain(key);
  for (const t of thrown) {
    const text = t instanceof Error ? inspect(t, { depth: null }) : String(t);
    expect(text).not.toContain(key);
  }
}

async function drive(key: string, fetchImpl: FetchImpl, opts: { esThrows?: boolean; streaming?: boolean } = {}) {
  const thrown: unknown[] = [];
  const capture = async (fn: () => unknown) => {
    try {
      await fn();
    } catch (e) {
      thrown.push(e);
    }
  };
  const client = FeatureflipClient.get(
    {
      sdkKey: key,
      baseUrl: 'http://stub.invalid',
      streaming: opts.streaming ?? false,
      pollInterval: 600_000,
      flushInterval: 600_000,
      initTimeout: 2000,
    },
    platform(key, fetchImpl, opts.esThrows),
  );
  await capture(() => client.waitForInitialization());
  // Evaluate: ok, type mismatch, unknown flag.
  await capture(() => client.boolVariation('bool-flag', { key: 'u' }, false));
  await capture(() => client.stringVariation('bool-flag', { key: 'u' }, 'd'));
  await capture(() => client.boolVariation('no-such-flag', { key: 'u' }, false));
  await capture(() => client.variationDetail('no-such-flag', { key: 'u' }, false));
  // Events, with the events endpoint failing.
  await capture(() => client.track('evt', { key: 'u' }, { a: 1 }));
  await capture(() => client.identify({ key: 'u' }));
  await capture(() => client.flush());
  // Different-config get() on the same key: the "options ignored" warning path.
  const second = FeatureflipClient.get(
    { sdkKey: key, baseUrl: 'http://other.invalid', streaming: false },
    platform(key, fetchImpl),
  );
  await capture(() => second.close());
  await capture(() => client.close());
  return thrown;
}

describe.each([
  ['server', SERVER_KEY],
  ['client', CLIENT_KEY],
])('%s sentinel key never reaches logs or exceptions', (_name, key) => {
  it('init 200, events transport error quoting the key', async () => {
    const thrown = await drive(key, (url) =>
      url.endsWith('/v1/sdk/events') ? Promise.reject(leakyError(key)) : json(200, okBody),
    );
    expectClean(key, thrown);
  });

  it('init 401, events rejected permanently', async () => {
    const thrown = await drive(key, (url) =>
      url.endsWith('/v1/sdk/events') ? json(400) : json(401),
    );
    expectClean(key, thrown);
  });

  it('init 500', async () => {
    const thrown = await drive(key, () => json(500));
    expectClean(key, thrown);
  });

  it('init transport error quoting the key', async () => {
    const thrown = await drive(key, () => Promise.reject(leakyError(key)));
    expectClean(key, thrown);
  });

  it('SSE start failing with an error quoting the key', async () => {
    const thrown = await drive(key, () => json(200, okBody), { streaming: true, esThrows: true });
    expect(captured.join('\n')).toContain('could not start the SSE stream');
    expectClean(key, thrown);
  });
});

describe('createRedactingWarn', () => {
  const key = SERVER_KEY;

  it('turns a key inside an exception message (and its cause) into [redacted]', () => {
    createRedactingWarn(key)('boom:', leakyError(key));
    const out = captured.join('\n');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain(key);
  });

  it('does not mutate the caller error', () => {
    const err = leakyError(key);
    createRedactingWarn(key)(err);
    expect(err.message).toContain(key);
  });

  it('redacts structured fields', () => {
    createRedactingWarn(key)(`k=${key}`, { nested: { header: `Bearer ${key}` }, list: [key] });
    const out = captured.join('\n');
    expect(out).not.toContain(key);
    expect(out).toContain('[redacted]');
  });

  it('leaves a key shorter than 20 characters alone', () => {
    createRedactingWarn('short-key')('skipped a short-key word');
    expect(captured.join('\n')).toContain('skipped a short-key word');
  });
});

describe('createRedactingWarn hardening', () => {
  const key = SERVER_KEY;
  const out = () => captured.join('\n');
  const warn = () => createRedactingWarn(key);

  it('redacts a cause cycle', () => {
    const a = leakyError(key);
    (a as { cause?: unknown }).cause = a;
    warn()(a);
    expect(out()).not.toContain(key);
    expect(out()).toContain('[redacted]');
  });

  it('redacts repeated references', () => {
    const e = leakyError(key);
    warn()('x', e, e, { a: e, b: e });
    expect(out()).not.toContain(key);
  });

  it('redacts a cause chain deeper than the old cap', () => {
    let e: Error = new Error(`deep ${key}`);
    for (let i = 0; i < 12; i++) {
      const outer = new Error(`level ${i}`);
      (outer as { cause?: unknown }).cause = e;
      e = outer;
    }
    warn()(e);
    expect(out()).not.toContain(key);
  });

  it('never passes a flagged non-plain object through', () => {
    class Holder {
      constructor(public header: string) {}
    }
    warn()(
      new Headers({ Authorization: key }),
      new Map([['auth', key]]),
      new Set([key]),
      new URL(`http://x.invalid/?authorization=${key}`),
      new Holder(key),
      new Request('http://x.invalid/', { headers: { Authorization: key } }),
    );
    expect(out()).not.toContain(key);
  });

  it('keeps the reference of a clean non-plain object', () => {
    const m = new Map([['a', 'b']]);
    warn()(m);
    expect(spies[3]).toHaveBeenCalledWith(m);
  });

  it('keeps own props of an error and redacts them', () => {
    const e = Object.assign(new Error('boom'), {
      code: 'E_FETCH',
      status: 502,
      config: { headers: { Authorization: key } },
    });
    warn()(e);
    expect(out()).not.toContain(key);
    const arg = spies[3].mock.calls[0][0] as Error & { code: string; status: number };
    expect(arg.code).toBe('E_FETCH');
    expect(arg.status).toBe(502);
  });

  it('keeps AggregateError with redacted errors', () => {
    warn()(new AggregateError([new Error(`a ${key}`)], 'many'));
    const arg = spies[3].mock.calls[0][0];
    expect(arg).toBeInstanceOf(AggregateError);
    expect(out()).not.toContain(key);
  });

  it('does not throw on a throwing getter', () => {
    const bad = {
      get boom(): string {
        throw new Error('nope');
      },
    };
    expect(() => warn()(bad, 'ok')).not.toThrow();
  });
});

describe('default warn sinks do not recurse', () => {
  it('buildIdentity with no warn logs an invalid wrapper', () => {
    expect(() => buildIdentity(['bad token'])).not.toThrow();
    expect(captured.join('\n')).toContain('ignoring wrapper');
  });

  it('SafeSnapshotStore with no warn logs a failing store', async () => {
    const store = new SafeSnapshotStore({
      get: async () => {
        throw new Error('read');
      },
      put: async () => {
        throw new Error('write');
      },
    });
    await expect(store.get()).resolves.toBeUndefined();
    await expect(store.put('x')).resolves.toBeUndefined();
    expect(captured.join('\n')).toContain('snapshot store read failed');
  });
});
