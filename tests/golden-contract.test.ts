import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FeatureflipClient } from '../src/client.js';
import type { Platform } from '../src/platform/types.js';
import type { EvaluationEvent, EvaluationInspector, FlagDto } from '../src/core/types.js';

// The coreContractVectors class asserts the shared CORE's contract — typed-accessor
// strictness, malformed-variation handling — one layer above the evaluator the other
// golden classes cover.
//
// That layer had no executable cross-SDK spec: #1989 and #2281 each shipped as a
// 6-of-7-SDK divergence no CI could see. Unlike the other classes these vectors are
// hand-authored, because the engine has no opinion here and in fact disagrees — it
// returns null where an SDK must return the caller's default.
//
// `expect.reason` is a CANONICAL token mapped to this SDK's vocabulary below.

interface ContractVector {
  id: string;
  description: string;
  kind: 'typeMismatch' | 'match' | 'malformed' | 'notFound';
  flags: FlagDto[];
  flagKey: string;
  context: { userId: string; attributes: Record<string, unknown> };
  read: { as: 'bool' | 'string' | 'number' | 'int' | 'double'; default: unknown };
  expect: { value: unknown; reason: string };
}

const vectors = (
  JSON.parse(
    readFileSync(new URL('./golden/vectors.json', import.meta.url), 'utf8'),
  ) as { coreContractVectors: ContractVector[] }
).coreContractVectors;

/** Canonical token -> this SDK's reason spelling. */
const REASONS: Record<string, string> = {
  Error: 'Error',
  Fallthrough: 'Fallthrough',
  FlagNotFound: 'FlagNotFound',
};

function md5(input: string): Uint8Array {
  return createHash('md5').update(input, 'utf8').digest();
}

function platformServing(flags: FlagDto[]): Platform {
  return {
    md5,
    createEventSource: () => ({
      addEventListener: () => {},
      close: () => {},
      readyState: 2,
    }),
    fetch: async () =>
      ({ ok: true, json: async () => ({ flags, segments: [] }) }) as unknown as Response,
  } as unknown as Platform;
}

describe('golden: core contract vectors', () => {
  afterEach(async () => {
    await FeatureflipClient.resetForTesting();
  });

  it('has vectors to run', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  let executed = 0;

  for (const v of vectors) {
    // js-sdk has no separate int accessor — numberVariation covers every JSON
    // number. Skipping is explicit so a capability gap can't look like a pass.
    if (v.read.as === 'int') continue;
    executed++;

    it(`${v.id}: ${v.description}`, async () => {
      const events: EvaluationEvent[] = [];
      const inspector: EvaluationInspector = (e) => events.push(e);

      const client = FeatureflipClient.get(
        {
          sdkKey: `contract-${v.id}`,
          baseUrl: 'http://localhost:0',
          streaming: false,
          inspectors: [inspector],
        },
        platformServing(v.flags),
      );

      try {
        await client.waitForInitialization();
        const ctx = { user_id: v.context.userId, ...v.context.attributes };

        let got: unknown;
        switch (v.read.as) {
          case 'bool':
            got = client.boolVariation(v.flagKey, ctx, v.read.default as boolean);
            break;
          case 'string':
            got = client.stringVariation(v.flagKey, ctx, v.read.default as string);
            break;
          case 'number':
          case 'double':
            got = client.numberVariation(v.flagKey, ctx, v.read.default as number);
            break;
          default:
            throw new Error(`unmapped read.as ${v.read.as} — add it to the switch`);
        }

        expect(got).toStrictEqual(v.expect.value);

        // Typed accessors return only a value, so the reason is observed through
        // the inspector — the same surface a real caller would use.
        expect(events).toHaveLength(1);
        expect(events[0].reason).toBe(REASONS[v.expect.reason]);
      } finally {
        await client.close();
      }
    });
  }

  // A runner that silently skips everything is worse than no runner at all.
  it('executed the expected number of vectors', () => {
    expect(executed).toBeGreaterThanOrEqual(12);
  });
});
