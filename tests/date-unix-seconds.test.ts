import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/core/evaluator';
import type { EvaluatorDeps } from '../src/core/evaluator';
import type { ConditionOperator, FlagDto } from '../src/core/types';
import { createHash } from 'crypto';

/**
 * Bare-integer date operands are Unix SECONDS (#2432).
 *
 * The shared `conditionVectors` pin the contract itself — that `"2024"` is 1970 and
 * not the year 2024, and that `"+5"` is a timestamp rather than an unparseable string
 * (`c-date-unix-leading-plus-*`, added with #2458) — against the engine. What they
 * cannot express is the exact RANGE boundary, because that needs values chosen against
 * `DateTimeOffset`'s limits rather than against an evaluation outcome, and it is what
 * stops a MILLISECONDS timestamp (the natural mistake — `Date.now()` returns one) from
 * resolving to an instant in the year 55829 and satisfying every `After` comparison.
 *
 * The sign-class cases below are kept even though a vector now covers them: they assert
 * it in BOTH directions (`After` and `Before`), where the vector asserts one outcome.
 *
 * Timezone independence is NOT re-tested here: it now follows structurally, because a
 * bare integer never reaches `Date.parse` at all. `Date.parse` was the only
 * locale-sensitive step (it resolved non-ISO forms like `"0"` in LOCAL time), and the
 * shared vectors fail in every timezone if it is ever reintroduced ahead of the
 * integer branch.
 */

const md5 = (input: string) => createHash('md5').update(input, 'utf8').digest();

function flagWithDateCondition(op: ConditionOperator, target: string): FlagDto {
  return {
    key: 'cond', version: 1, type: 'String', enabled: true,
    variations: [
      { key: 'match', value: 'match' },
      { key: 'nomatch', value: 'nomatch' },
    ],
    rules: [{
      id: 'r', priority: 0,
      conditionGroups: [{
        operator: 'And',
        conditions: [{ attribute: 'attr', operator: op, values: [target], negate: false }],
      }],
      serve: { type: 'Fixed', variation: 'match' },
    }],
    fallthrough: { type: 'Fixed', variation: 'nomatch' },
    offVariation: 'nomatch',
    prerequisites: [],
  };
}

/** Whether the single date condition matched, driven through the real evaluator. */
function matches(attr: string, op: ConditionOperator, target: string): boolean {
  const deps: EvaluatorDeps = { md5 };
  return (
    evaluate(flagWithDateCondition(op, target), { attr }, deps, {}).variationKey ===
    'match'
  );
}

// DateTimeOffset.MinValue / MaxValue as unix seconds.
const MIN = '-62135596800';
const MAX = '253402300799';

describe('bare-integer date operands are unix seconds (#2432)', () => {
  it('accepts the exact range boundaries the engine accepts', () => {
    // Just inside: both bounds resolve, so a comparison against the epoch works.
    expect(matches(MAX, 'After', '0')).toBe(true);
    expect(matches(MIN, 'Before', '0')).toBe(true);
  });

  it('matches nothing just outside the range, rather than wrapping', () => {
    // One second past each bound. The engine's FromUnixTimeSeconds throws here and
    // TryParseDateTime returns false, so the condition matches nothing at all —
    // note BOTH directions are false, which is what distinguishes "unparseable"
    // from "parsed to some extreme instant".
    expect(matches('253402300800', 'After', '0')).toBe(false);
    expect(matches('253402300800', 'Before', '0')).toBe(false);
    expect(matches('-62135596801', 'After', '0')).toBe(false);
    expect(matches('-62135596801', 'Before', '0')).toBe(false);
  });

  it('matches nothing for a milliseconds timestamp pasted where seconds belong', () => {
    // The realistic trigger for the bound above, and the reason it is not merely
    // theoretical: Date.now() is the obvious way to produce a timestamp, and before
    // the range check this resolved to the year 55829 and was After everything.
    expect(matches('1700000000000', 'After', '0')).toBe(false);
    expect(matches('1700000000000', 'Before', '0')).toBe(false);
  });

  it('accepts a leading + sign, like long.TryParse', () => {
    expect(matches('+5', 'After', '0')).toBe(true);
    expect(matches('+5', 'Before', '10')).toBe(true);
  });

  it('still parses ISO-8601 operands, which must not regress to unix', () => {
    // The integer branch is checked first, so this guards the other half: a string
    // that is not entirely digits must still reach the date parse.
    expect(matches('2023-05-15T12:00:00Z', 'After', '2023-05-15T09:00:00Z')).toBe(true);
    expect(matches('2023-05-15', 'Before', '2023-05-16')).toBe(true);
    // Offset-less forms are assumed UTC, mirroring the engine's AssumeUniversal.
    expect(matches('2023-05-15T12:00:00', 'After', '2023-05-15T11:00:00')).toBe(true);
  });

  it('matches nothing for a non-numeric, non-date string', () => {
    expect(matches('not-a-date', 'After', '0')).toBe(false);
    expect(matches('1e9', 'After', '0')).toBe(false);
  });
});
