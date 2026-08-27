import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/core/evaluator';
import type { EvaluatorDeps } from '../src/core/evaluator';
import type { ConditionOperator, FlagDto } from '../src/core/types';
import { createHash } from 'crypto';

/**
 * A date operand that matches the ISO grammar but names no real calendar day must
 * match NOTHING, as it does in the engine, csharp, go, python and java (#2491).
 *
 * #2480 converged the seven SDKs on one ISO grammar, but a character class cannot
 * express "is a real day": `2024-02-30` matches `\d{4}-\d{2}-\d{2}` everywhere, so the
 * grammar guard is silent on it. Three SDKs then ROLLED IT OVER — js, ruby and php all
 * resolved it to 2024-03-01 — while the engine and the other four rejected it. A flag
 * therefore served different variations to two users purely by which SDK their service
 * used, off one saved rule.
 *
 * This is one of the few cross-SDK date questions where the engine is NOT the outlier,
 * so unlike #2480 the fix moves js TOWARD the engine rather than away from it, and the
 * expectations here are engine-generated in the shared golden vectors
 * (`c-date-unreal-*`) rather than hand-authored.
 *
 * The rollover was invisible to any suite that only asserted parseability: the operand
 * parses fine, just to the wrong instant. These tests assert the OUTCOME of a
 * comparison that inverts across the month boundary instead.
 */

const md5 = (input: string) => createHash('md5').update(input, 'utf8').digest();

function flagWithDateCondition(op: ConditionOperator, target: string): FlagDto {
  return {
    key: 'cond',
    version: 1,
    type: 'String',
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
            operator: 'And',
            conditions: [
              { attribute: 'attr', operator: op, values: [target], negate: false },
            ],
          },
        ],
        serve: { type: 'Fixed', variation: 'match' },
      },
    ],
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

/**
 * An operand that parses to SOME instant satisfies exactly one of these; one that
 * parses to nothing satisfies neither. Comparing in both directions AND on both sides
 * of the condition is what separates "unparseable" from "parsed to an extreme
 * instant" — a single assertion cannot, and a rolled-over date is a perfectly ordinary
 * instant.
 */
function unparseable(operand: string): boolean {
  return (
    !matches(operand, 'After', '0') &&
    !matches(operand, 'Before', '0') &&
    !matches('0', 'After', operand) &&
    !matches('0', 'Before', operand)
  );
}

describe('date operands naming no real calendar day match nothing (#2491)', () => {
  // The reported class: the day is within 01-31 so the grammar admits it, but the
  // month is shorter than that. All three rolling SDKs resolved these to the 1st of
  // the following month.
  it.each([
    ['2024-02-30', 'February 30 in a leap year'],
    ['2024-02-31', 'February 31 in a leap year'],
    ['2023-02-29', 'February 29 in a NON-leap year'],
    ['2023-02-30', 'February 30 in a non-leap year'],
    ['2024-04-31', 'April has 30 days'],
    ['2024-06-31', 'June has 30 days'],
    ['2024-09-31', 'September has 30 days'],
    ['2024-11-31', 'November has 30 days'],
  ])('rejects %j (%s)', (operand) => {
    expect(unparseable(operand)).toBe(true);
  });

  // The century rule. 1900 and 2100 are divisible by 100 but not 400, so neither is a
  // leap year — the case a naive `year % 4 === 0` check accepts.
  it.each(['1900-02-29', '1800-02-29', '2100-02-29', '2200-02-29'])(
    'rejects %j (century year divisible by 100 but not 400 is not a leap year)',
    (operand) => {
      expect(unparseable(operand)).toBe(true);
    },
  );

  // Structurally out of range. These already matched nothing here, because `Date.parse`
  // happens to return NaN for them — pinned so the explicit check that now replaces
  // that incidental rejection cannot silently widen or narrow it.
  it.each([
    ['2024-13-01', 'month 13'],
    ['2024-99-01', 'month 99'],
    ['2024-01-32', 'day 32'],
    ['2024-01-99', 'day 99'],
  ])('rejects %j (%s)', (operand) => {
    expect(unparseable(operand)).toBe(true);
  });

  // Zero month / zero day. js and ruby already rejected these; php ALONE rolled them
  // BACKWARDS into the previous year (2023-12-01 and 2023-12-31). Pinned in all three
  // so the contract is stated once rather than per-SDK.
  it.each([
    ['2024-00-01', 'month 0'],
    ['2024-01-00', 'day 0'],
    ['2024-00-00', 'month and day both 0'],
  ])('rejects %j (%s)', (operand) => {
    expect(unparseable(operand)).toBe(true);
  });

  // The check is on the WRITTEN date, so a time component or an offset cannot smuggle
  // one past it.
  it.each([
    ['2024-02-30T12:00:00Z', 'with a time and Z'],
    ['2024-02-30 00:00:00', 'with a space separator and no offset'],
    ['2024-02-30T00:00:00.500Z', 'with fractional seconds'],
    ['2024-02-30T00:00:00+0500', 'with a basic offset'],
  ])('rejects %j (%s)', (operand) => {
    expect(unparseable(operand)).toBe(true);
  });

  // The decisive one. `2024-02-30T00:00:00+05:00` resolves to 2024-02-29T19:00Z, whose
  // UTC date IS a real day — so an implementation that validated the RESOLVED UTC
  // components instead of the written triple would accept it and stay divergent.
  it('rejects an unreal day whose offset would shift it onto a real UTC day', () => {
    expect(unparseable('2024-02-30T00:00:00+05:00')).toBe(true);
  });
});

describe('the rollover itself is gone, not merely unasserted (#2491)', () => {
  // Before the fix `2024-02-30` resolved to 2024-03-01, so this Before comparison was
  // TRUE. The control on the next line is the same assertion against the date it used
  // to roll into, proving the comparison itself still works and only the unreal
  // operand changed.
  it('does not resolve 2024-02-30 to 2024-03-01', () => {
    expect(matches('2024-02-30', 'Before', '2024-03-02')).toBe(false);
    expect(matches('2024-03-01', 'Before', '2024-03-02')).toBe(true);
  });

  it('does not resolve 2023-02-29 to 2023-03-01', () => {
    expect(matches('2023-02-29', 'Before', '2023-03-02')).toBe(false);
    expect(matches('2023-03-01', 'Before', '2023-03-02')).toBe(true);
  });

  it('does not resolve an unreal day on the CONDITION side either', () => {
    expect(matches('2024-06-01', 'After', '2024-02-30')).toBe(false);
    expect(matches('2024-06-01', 'After', '2024-03-01')).toBe(true);
  });
});

describe('real calendar days still resolve (#2491)', () => {
  // Every month's true last day, in a leap year and a non-leap year. This is what stops
  // the check from over-rejecting, and it walks the whole month-length table rather
  // than sampling it.
  const monthEnds = (year: number, feb: number) =>
    [31, feb, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].map(
      (d, i) =>
        `${year}-${String(i + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    );

  it.each([
    ...monthEnds(2024, 29),
    ...monthEnds(2023, 28),
    '2024-01-01',
    '2024-12-31',
  ])('accepts %j', (operand) => {
    expect(unparseable(operand)).toBe(false);
  });

  // Both halves of the century rule: divisible by 400 IS a leap year.
  it.each(['2000-02-29', '1600-02-29', '2400-02-29'])(
    'accepts %j (century year divisible by 400 is a leap year)',
    (operand) => {
      expect(unparseable(operand)).toBe(false);
    },
  );

  it('accepts a real day carrying a time and an offset', () => {
    expect(unparseable('2024-02-29T12:00:00+05:00')).toBe(false);
  });
});
