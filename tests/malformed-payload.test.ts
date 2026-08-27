import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { FeatureflipClient } from '../src/client.js';
import { FlagStore } from '../src/core/store.js';
import {
  MalformedPayloadError,
  validateSnapshot,
  validateFlag,
} from '../src/core/validate-snapshot.js';
import type { Platform, EventSourceLike } from '../src/platform/types.js';
import type { GetFlagsResponse } from '../src/core/types.js';

/**
 * A config payload that violates the wire contract must be discarded WHOLESALE,
 * never partially applied, and never silently (packages/CLAUDE.md; #2315).
 *
 * The js core had none of that: the `as GetFlagsResponse` cast is erased at runtime,
 * so `conditionLogic: 0` was stored verbatim and then failed the `=== 'And'` check,
 * flipping a segment from matching ALL of its conditions to ANY of them — over-
 * targeting, i.e. failing OPEN. #2279 is the server bug that made integer enums reach
 * SDKs at all.
 *
 * Validation is deliberately TYPE-ONLY. An unrecognised operator *string* is how a
 * newer server ships a new operator, and #2262 already makes the evaluator fail closed
 * on one — rejecting it here would break the SDK against every future server.
 */

function wellFormed(): GetFlagsResponse {
  return {
    environment: 'test',
    version: 1,
    flags: [
      {
        key: 'bool-flag',
        version: 1,
        type: 'Boolean',
        enabled: true,
        variations: [{ key: 'on', value: true }, { key: 'off', value: false }],
        rules: [],
        fallthrough: { type: 'Fixed', variation: 'on' },
        offVariation: 'off',
      },
    ],
    segments: [
      { key: 'seg', version: 1, conditionLogic: 'And', conditions: [
        { attribute: 'plan', operator: 'Equals', values: ['pro'], negate: false },
      ] },
    ],
  };
}

// Each mutation violates the TYPE contract at a different enum-carrying field.
const TYPE_VIOLATIONS: Array<[string, (s: GetFlagsResponse) => void]> = [
  ['flag.type', (s) => { (s.flags[0] as any).type = 0; }],
  ['flag.fallthrough.type', (s) => { (s.flags[0].fallthrough as any).type = 0; }],
  ['segment.conditionLogic', (s) => { (s.segments[0] as any).conditionLogic = 0; }],
  ['segment.condition.operator', (s) => { (s.segments[0].conditions[0] as any).operator = 0; }],
  ['rule.serve.type', (s) => {
    (s.flags[0].rules as any) = [{ id: 'r', priority: 1, conditionGroups: [],
      serve: { type: 0, variation: 'on' } }];
  }],
  ['rule.conditionGroup.operator', (s) => {
    (s.flags[0].rules as any) = [{ id: 'r', priority: 1, serve: { type: 'Fixed', variation: 'on' },
      conditionGroups: [{ operator: 0, conditions: [] }] }];
  }],
  ['rule.conditionGroup.condition.operator', (s) => {
    (s.flags[0].rules as any) = [{ id: 'r', priority: 1, serve: { type: 'Fixed', variation: 'on' },
      conditionGroups: [{ operator: 'And', conditions: [
        { attribute: 'a', operator: 0, values: ['x'], negate: false }] }] }];
  }],
];

describe('validateSnapshot — type violations are rejected', () => {
  it.each(TYPE_VIOLATIONS)('rejects a non-string %s', (_field, mutate) => {
    const snapshot = wellFormed();
    mutate(snapshot);

    expect(() => validateSnapshot(snapshot)).toThrow(MalformedPayloadError);
  });

  it.each([
    ['flags', (s: any) => { s.flags = null; }],
    ['segments', (s: any) => { s.segments = null; }],
    ['flags (not an array)', (s: any) => { s.flags = {}; }],
  ])('rejects a malformed top-level %s', (_field, mutate) => {
    const snapshot = wellFormed();
    mutate(snapshot);

    expect(() => validateSnapshot(snapshot)).toThrow(MalformedPayloadError);
  });

  it('accepts the well-formed control', () => {
    expect(() => validateSnapshot(wellFormed())).not.toThrow();
  });
});

describe('validateSnapshot — forward compatibility', () => {
  it('ACCEPTS an unrecognised operator string', () => {
    // This is how a newer server ships a new operator. The evaluator fails closed on
    // it (#2262); rejecting the whole config here would break every future server.
    const snapshot = wellFormed();
    (snapshot.segments[0].conditions[0] as any).operator = 'SomeFutureOperator';

    expect(() => validateSnapshot(snapshot)).not.toThrow();
  });

  it('ACCEPTS an unrecognised flag type string', () => {
    const snapshot = wellFormed();
    (snapshot.flags[0] as any).type = 'SomeFutureType';

    expect(() => validateSnapshot(snapshot)).not.toThrow();
  });

  it('ACCEPTS unknown extra properties', () => {
    const snapshot = wellFormed() as any;
    snapshot.someNewFieldFromANewerServer = { nested: true };
    snapshot.flags[0].anotherNewField = 42;

    expect(() => validateSnapshot(snapshot)).not.toThrow();
  });
});

/**
 * The other direction, and the one that actually carries risk: a validator that is too
 * STRICT rejects real traffic and takes the SDK down against a healthy server. Golden
 * vectors are engine-generated and byte-identical across all 8 SDK copies, so they are
 * the closest thing in-repo to real wire output — if the validator rejects one of these,
 * it would reject production.
 */
describe('validateSnapshot vs engine-generated fixtures', () => {
  const golden = JSON.parse(
    readFileSync(new URL('./golden/vectors.json', import.meta.url), 'utf8'),
  ) as { flagVectors: Array<{ id: string; flags: unknown[]; segments: unknown[] }> };

  it('has fixtures to check', () => {
    expect(golden.flagVectors.length).toBeGreaterThan(0);
  });

  it.each(golden.flagVectors.map((v) => [v.id, v] as const))(
    'accepts the engine-generated flags/segments of %s',
    (_id, vector) => {
      expect(() =>
        validateSnapshot({
          environment: 'test',
          version: 1,
          flags: vector.flags,
          segments: vector.segments,
        } as any),
      ).not.toThrow();
    },
  );
});

describe('validateFlag — single-flag delta path', () => {
  it('rejects an integer type', () => {
    const flag = { ...wellFormed().flags[0], type: 0 } as any;

    expect(() => validateFlag(flag)).toThrow(MalformedPayloadError);
  });

  it('accepts a well-formed flag', () => {
    expect(() => validateFlag(wellFormed().flags[0])).not.toThrow();
  });
});

describe('FlagStore.init is atomic', () => {
  it('leaves a COLD store untouched when the snapshot throws mid-apply', () => {
    // The original bug: init() cleared both maps, populated flags, then threw on
    // segments — leaving flags applied, version unset and hasSnapshot false.
    const store = new FlagStore();
    const flags: any = [{ key: 'a', enabled: true, variations: [] }];

    expect(() => store.init(flags, null as any, 7)).toThrow();

    expect(store.getFlag('a')).toBeUndefined();
    expect(store.getAllFlags()).toHaveLength(0);
  });

  it('leaves a WARM store untouched when the snapshot throws mid-apply', () => {
    const store = new FlagStore();
    const good = wellFormed();
    store.init(good.flags, good.segments, 1);

    expect(() => store.init(good.flags, null as any, 2)).toThrow();

    expect(store.getFlag('bool-flag')).toBeDefined();
    expect(store.getSegment('seg')).toBeDefined();
  });

  it('still applies a well-formed snapshot', () => {
    const store = new FlagStore();
    const good = wellFormed();

    store.init(good.flags, good.segments, 3);

    expect(store.getFlag('bool-flag')).toBeDefined();
    expect(store.getSegment('seg')).toBeDefined();
  });
});

// --- End-to-end: a malformed sync frame over SSE ---

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
    md5: (input: string) => createHash('md5').update(input, 'utf8').digest(),
    createEventSource: () => {
      const listeners = new Map<string, ((event: { data: string }) => void)[]>();
      const es: MockEventSource = {
        addEventListener(type: string, listener: (event: { data: string }) => void) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        close: vi.fn(),
        readyState: 1,
        emit(type, data) {
          for (const l of listeners.get(type) ?? []) l({ data: data ?? '' });
        },
      };
      mockEventSources.push(es);
      return es;
    },
    fetch: fetchMock,
    mockEventSources,
    fetchMock,
  } as any;
}

describe('a malformed SSE sync frame', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await FeatureflipClient.resetForTesting();
  });

  async function streamingClient() {
    const platform = createMockPlatform();
    platform.fetchMock.mockResolvedValue({ ok: true, json: async () => wellFormed() });
    const client = FeatureflipClient.get(
      { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true },
      platform,
    );
    await client.waitForInitialization();
    return { client, platform };
  }

  it('is discarded wholesale, leaving the previous config serving', async () => {
    const { client, platform } = await streamingClient();
    expect(client.boolVariation('bool-flag', { userId: 'u' }, false)).toBe(true);

    const bad = wellFormed();
    (bad.segments[0] as any).conditionLogic = 0;
    platform.mockEventSources[0].emit('sync', JSON.stringify(bad));

    // Previous config still serving — not replaced by the malformed one.
    expect(client.boolVariation('bool-flag', { userId: 'u' }, false)).toBe(true);
  });

  it('emits a diagnostic rather than failing silently', async () => {
    const { platform } = await streamingClient();

    const bad = wellFormed();
    (bad.segments[0] as any).conditionLogic = 0;
    platform.mockEventSources[0].emit('sync', JSON.stringify(bad));

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[featureflip]'),
      expect.anything(),
    );
  });

  it('is reported on the segment.updated refetch path too', async () => {
    // Every path that reaches store.init must report a contract violation, not just
    // the `sync` handler. This one refetches via HTTP in response to an SSE event, so
    // it is easy to miss — it was, on the first pass through this fix.
    const { platform } = await streamingClient();

    const bad = wellFormed();
    (bad.segments[0] as any).conditionLogic = 0;
    platform.fetchMock.mockResolvedValue({ ok: true, json: async () => bad });

    platform.mockEventSources[0].emit('segment.updated', '{}');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('segment.updated refetch'),
      expect.anything(),
    );
  });

  it('still applies a well-formed sync frame', async () => {
    const { client, platform } = await streamingClient();

    const next = wellFormed();
    next.flags[0].enabled = false;
    platform.mockEventSources[0].emit('sync', JSON.stringify(next));

    expect(client.boolVariation('bool-flag', { userId: 'u' }, true)).toBe(false);
  });
});
