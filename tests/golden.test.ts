import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { computeBucket, evaluate } from '../src/core/evaluator.js';
import type { EvaluatorDeps } from '../src/core/evaluator.js';

const md5 = (s: string): Uint8Array =>
  new Uint8Array(createHash('md5').update(s).digest());

const vectors = JSON.parse(
  readFileSync(new URL('./golden/vectors.json', import.meta.url), 'utf8'),
) as {
  bucketVectors: Array<{ id: string; salt: string; value: string; expectedBucket: number }>;
  rolloutVectors: Array<{
    id: string;
    salt: string;
    value: string;
    variations: Array<{ key: string; weight: number }>;
    expectedVariation: string;
  }>;
  conditionVectors: ConditionVector[];
  unknownOperatorVectors: ConditionVector[];
  dateGrammarVectors: ConditionVector[];
  flagVectors: Array<{
    id: string;
    flagKey: string;
    flags: unknown[];
    segments: Array<{ key: string; version: number; conditions: unknown[]; conditionLogic: string }>;
    context: { userId: string; attributes: Record<string, unknown> };
    expected: { variation: string; value: unknown; reason: { kind: string; ruleId?: string; prerequisiteKey?: string } };
  }>;
};

type ConditionVector = {
  id: string;
  attribute: { type: string; value: unknown };
  operator: string;
  values: string[];
  negate: boolean;
  expectedMatch: boolean;
};

function normalizeReason(d: { reason: string; ruleId?: string; prerequisiteKey?: string }) {
  const out: { kind: string; ruleId?: string; prerequisiteKey?: string } = { kind: d.reason };
  if (d.ruleId != null) out.ruleId = d.ruleId;
  if (d.prerequisiteKey != null) out.prerequisiteKey = d.prerequisiteKey;
  return out;
}

// ─── Bucket vectors ────────────────────────────────────────────────────────────

describe('golden bucketVectors', () => {
  for (const v of vectors.bucketVectors) {
    it(v.id, () => {
      expect(computeBucket(v.salt, v.value, md5)).toBe(v.expectedBucket);
    });
  }
});

// ─── Rollout vectors ───────────────────────────────────────────────────────────

describe('golden rolloutVectors', () => {
  for (const v of vectors.rolloutVectors) {
    it(v.id, () => {
      const flag = {
        key: 'rollout',
        version: 1,
        type: 'String' as const,
        enabled: true,
        variations: v.variations.map((w) => ({ key: w.key, value: w.key })),
        rules: [],
        fallthrough: {
          type: 'Rollout' as const,
          salt: v.salt,
          bucketBy: 'userId',
          variations: v.variations,
        },
        offVariation: v.variations[0]!.key,
        prerequisites: [],
      };
      const ctx = { userId: v.value };
      const deps: EvaluatorDeps = { md5 };
      const r = evaluate(flag, ctx, deps, {});
      expect(r.variationKey).toBe(v.expectedVariation);
    });
  }
});

// ─── Condition vectors ─────────────────────────────────────────────────────────

// Builds the single-condition flag a condition vector describes and reports
// whether the rule matched. Shared by conditionVectors and
// unknownOperatorVectors, which have an identical input shape.
function conditionVectorMatches(v: ConditionVector): boolean {
  // The fixture attribute carries a typed value. Pass it natively so the
  // evaluator's numeric-coercion and boolean-exclusion logic can apply.
  const attrValue = v.attribute.value;
  const flag = {
        key: 'cond',
        version: 1,
        type: 'String' as const,
        enabled: true,
        variations: [
          { key: 'match', value: 'match' },
          { key: 'nomatch', value: 'nomatch' },
        ],
        rules: [
          {
            id: 'r',
            priority: 0,
            conditionGroups: [
              {
                operator: 'And' as const,
                conditions: [
                  {
                    attribute: 'attr',
                    operator: v.operator as never,
                    values: v.values,
                    negate: v.negate ?? false,
                  },
                ],
              },
            ],
            serve: { type: 'Fixed' as const, variation: 'match' },
            segmentKey: undefined,
          },
        ],
        fallthrough: { type: 'Fixed' as const, variation: 'nomatch' },
        offVariation: 'nomatch',
        prerequisites: [],
      };
  const ctx = { attr: attrValue };
  const deps: EvaluatorDeps = { md5 };
  return evaluate(flag, ctx, deps, {}).variationKey === 'match';
}

describe('golden conditionVectors', () => {
  for (const v of vectors.conditionVectors) {
    it(v.id, () => {
      expect(conditionVectorMatches(v)).toBe(v.expectedMatch);
    });
  }
});

// ─── Unknown-operator vectors ──────────────────────────────────────────────────
//
// Hand-authored (#2262), not engine-generated: the generator resolves operators
// with Enum.Parse<ConditionOperator>, which throws on an unrecognised name, so
// these cases cannot exist as conditionVectors. They lock the rule that an
// operator this SDK does not recognise means "cannot evaluate", NOT "did not
// match" — so `negate` must never invert it into a match-everyone, which
// would serve the flag to 100% of traffic.
describe('golden unknownOperatorVectors', () => {
  for (const v of vectors.unknownOperatorVectors) {
    it(v.id, () => {
      expect(conditionVectorMatches(v)).toBe(v.expectedMatch);
    });
  }
});

// ─── Date-grammar vectors ──────────────────────────────────────────────────────
// Hand-authored because the ENGINE DISSENTS: DateTimeOffset.TryParse under the
// invariant culture resolves `05/15/2023`, `Jan 1 2024` and `2024.01.01`, so
// generating these would assert the opposite of what every SDK must do (#2480).
// The engine keeps that leniency on purpose — narrowing it would stop an already-
// saved operand from evaluating — and Management rejects them on write instead.
//
// js is why the class exists: it alone resolved a non-ISO operand in the HOST's
// timezone, so one saved rule evaluated differently per host. The six SDKs that
// always rejected these did so as a side effect of their grammar, and not one of
// them asserted it — the invisible-divergence shape of #1989 and #2281.
describe('golden dateGrammarVectors', () => {
  for (const v of vectors.dateGrammarVectors) {
    it(v.id, () => {
      expect(conditionVectorMatches(v)).toBe(v.expectedMatch);
    });
  }

  // A runner that silently iterated nothing would "pass" every rejection vector for
  // the wrong reason — the same guard every hand-authored class carries.
  it('ran the whole class', () => {
    expect(vectors.dateGrammarVectors.length).toBeGreaterThanOrEqual(64);
  });
});

// ─── Flag vectors ──────────────────────────────────────────────────────────────

describe('golden flagVectors', () => {
  for (const v of vectors.flagVectors) {
    it(v.id, () => {
      // Build allFlags map from the fixture's flag array
      const allFlags: Record<string, never> = {};
      for (const f of v.flags) {
        const flag = f as { key: string };
        allFlags[flag.key] = f as never;
      }

      // Wire segments via deps.getSegment so segment-keyed rules resolve
      const segmentMap = new Map(v.segments.map((s) => [s.key, s]));

      const deps: EvaluatorDeps = {
        md5,
        getSegment: segmentMap.size > 0
          ? (key: string) => segmentMap.get(key) as never
          : undefined,
      };

      // Merge userId + attributes into a flat EvaluationContext
      const ctx: Record<string, unknown> = {
        userId: v.context.userId,
        ...v.context.attributes,
      };

      const targetFlag = allFlags[v.flagKey];
      const r = evaluate(targetFlag, ctx, deps, allFlags);

      expect(r.variationKey).toBe(v.expected.variation);
      // Sort object keys so the comparison is independent of property order
      // (the .NET generator and the JS evaluator need not emit keys in the same order).
      const sortKeys = (_k: string, val: unknown): unknown =>
        val && typeof val === 'object' && !Array.isArray(val)
          ? Object.fromEntries(
              Object.entries(val as Record<string, unknown>).sort((a, b) =>
                a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
              ),
            )
          : val;
      expect(JSON.stringify(r.value, sortKeys)).toBe(JSON.stringify(v.expected.value, sortKeys));
      expect(normalizeReason(r as { reason: string; ruleId?: string; prerequisiteKey?: string })).toEqual(v.expected.reason);
    });
  }
});
