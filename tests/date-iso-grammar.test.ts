import { describe, it, expect, afterEach } from 'vitest';
import { evaluate } from '../src/core/evaluator';
import type { EvaluatorDeps } from '../src/core/evaluator';
import type { ConditionOperator, FlagDto } from '../src/core/types';
import { createHash } from 'crypto';

/**
 * A date operand must satisfy the ISO-8601 grammar the other six evaluators pin,
 * or match nothing (#2480).
 *
 * js was the only implementation that handed the raw operand to its platform date
 * parser. `Date.parse` accepts far more than ISO — `05/15/2023`, `Jan 1 2024`,
 * `2024.01.01` — and, decisively, resolves every one of those NON-ISO forms in the
 * HOST's timezone, because ECMAScript only mandates UTC-by-default for the ISO
 * shapes it specifies. Everything else falls to an implementation-defined parser
 * that assumes local time.
 *
 * So the same saved targeting rule evaluated to a different instant per host, and in a
 * browser that means a different flag value per user timezone. (This package running under
 * its `browser` export condition — `@featureflip/browser` POSTs to /v1/client/evaluate and
 * never evaluates locally, so it cannot carry this bug.) That is the
 * same failure class as #2432 (bare integers parsed as years) and the NUL/whitespace
 * path #2468 closed; these operands survived both because they carry no forbidden
 * character and never reach the integer branch.
 *
 * It is also the reachable one. `05/15/2023` is what a US customer gets from a date
 * picker or types by hand into the targeting UI — unlike the control-character
 * operands #2468 dealt with, which take deliberate effort to produce.
 *
 * The engine remains the lone outlier: `DateTimeOffset.TryParse` with the invariant
 * culture still accepts these and resolves them at UTC midnight. Narrowing IT would
 * stop an operand that evaluates today from evaluating at all, for rules customers
 * may already have saved, so it is a data-migration decision tracked separately.
 * Converging the seven SDKs on one rule is strictly better than today, where js is
 * an outlier among the SDKs as well as against the engine — and it removes the only
 * silently-WRONG behaviour of the three.
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
 * parses to nothing satisfies neither. Comparing both directions is what separates
 * "unparseable" from "parsed to an extreme instant", which a single assertion can't.
 */
function unparseable(operand: string): boolean {
  return (
    !matches(operand, 'After', '0') &&
    !matches(operand, 'Before', '0') &&
    !matches('0', 'After', operand) &&
    !matches('0', 'Before', operand)
  );
}

describe('date operands outside the ISO-8601 grammar match nothing (#2480)', () => {
  // Formats `Date.parse` accepts and every other evaluator rejects. Each resolves
  // in the host's timezone, so before the guard these produced a different instant
  // in New York than in UTC — off ONE saved config.
  it.each([
    ['05/15/2023', 'US slash date — what a date picker or a US customer types'],
    ['5/15/2023', 'unpadded US slash date'],
    ['2024/01/01', 'ISO-ordered but slash-separated'],
    ['Jan 1 2024', 'abbreviated month name'],
    ['January 1, 2024', 'full month name'],
    ['2024.01.01', 'dot-separated'],
    ['2024-1-1', 'ISO order without zero padding'],
    ['Mon, 15 May 2023 00:00:00 GMT', 'RFC 1123 / HTTP-date'],
  ])('rejects %j (%s)', (operand) => {
    expect(unparseable(operand)).toBe(true);
  });

  it('resolves no operand in the host timezone', () => {
    // The structural guarantee, asserted directly rather than inferred: every
    // accepted form is canonicalized to carry an explicit offset before it reaches
    // `Date.parse`, and every form that cannot be is rejected. So NO operand's
    // outcome may depend on TZ — which is the property #2432, #2468 and this fix
    // are all really defending. Node re-reads process.env.TZ per Date operation.
    const operands = [
      '05/15/2023',
      'Jan 1 2024',
      '2024-01-01',
      '2024-01-01T00:00:00',
      '2024-01-01 00:00:00',
      '2024-01-01T00:00:00Z',
      '2024-01-01T00:00:00+0500',
      '2024-01-01T00:00:00.5',
      '2024-01-01T00:00:00.123456789',
      '2024-01-01T00:00.5',
      '0',
    ];
    const outcomesIn = (tz: string) => {
      process.env.TZ = tz;
      return operands.map(
        (o) => `${o}:${matches(o, 'After', '2024-01-01T02:00:00Z')}`,
      );
    };
    const utc = outcomesIn('UTC');
    expect(outcomesIn('America/New_York')).toEqual(utc);
    expect(outcomesIn('Asia/Tokyo')).toEqual(utc);
    expect(outcomesIn('Pacific/Kiritimati')).toEqual(utc);
  });

  // The whole point of pinning the grammar is that the shapes #2468 converged on
  // keep working — the guard must not narrow js below the other six.
  it.each([
    ['2024-01-01', 'bare date, assumed UTC'],
    ['2024-01-01T00:00:00Z', 'extended with Z'],
    ['2024-01-01T00:00:00', 'offset-less date-time, assumed UTC'],
    ['2024-01-01 00:00:00', 'space separator'],
    ['2024-01-01T00:00', 'seconds omitted'],
    ['2024-01-01T00:00:00.5', 'fractional seconds'],
    ['2024-01-01T00:00:00.123456789Z', 'nanosecond fraction, truncated to ms'],
    ['2024-01-01T05:00:00+05:00', 'extended offset'],
    ['2024-01-01T05:00:00+0500', 'basic offset'],
  ])('still accepts %j (%s)', (operand) => {
    expect(unparseable(operand)).toBe(false);
    // All nine name the same instant, 2024-01-01T00:00:00(.000-.5)Z, so all nine
    // sit strictly between these two — which pins the VALUE, not just parseability.
    expect(matches(operand, 'After', '2023-12-31T23:59:59Z')).toBe(true);
    expect(matches(operand, 'Before', '2024-01-01T00:00:01Z')).toBe(true);
  });

  // Adopting the grammar verbatim is not purely a narrowing: `ISO_OPERAND` makes the
  // seconds and the fraction INDEPENDENTLY optional — `(?::(\d{2}))?(\.\d+)?` — so a
  // decimal can sit on the minutes position, and js now reads it as a fraction of
  // seconds. `Date.parse('2024-01-31T09:30.5')` was NaN, so this is 1,440 operands going
  // from no-match to matching.
  //
  // Kept rather than special-cased, because the five SDKs whose grammar this IS all
  // resolve it to 09:30:00.500 — matching them is the entire point. Note it puts js on
  // the five's side against the engine here: DateTimeOffset.TryParse REJECTS this shape, so
  // it is one of the few places this change moves js AWAY from the engine. Management's
  // write-path guard rejects it, so no new rule can carry one.
  it.each([
    ['2024-01-31T09:30.5', 'decimal on the minutes position'],
    ['2024-01-31 09:30.25', 'same, space separator'],
    ['2024-01-31T09:30.5Z', 'same, explicit offset'],
  ])('reads %j as a fraction of seconds (%s), matching the five SDKs', (operand) => {
    expect(unparseable(operand)).toBe(false);
    // 09:30:00.500 — strictly inside this window, which pins the VALUE not just parsing.
    expect(matches(operand, 'After', '2024-01-31T09:29:59Z')).toBe(true);
    expect(matches(operand, 'Before', '2024-01-31T09:30:01Z')).toBe(true);
  });

  // Adopting the grammar verbatim also drops the lowercase designators `Date.parse`
  // tolerated. Deliberate, and asserted rather than left as an unobserved side effect:
  // the pinned grammar is case-sensitive in go/java/python/ruby/php, so js accepting
  // them was a divergence from those five in its own right — just not a silently-wrong
  // one, since a lowercase operand does resolve to the correct instant. The engine and
  // the C# SDK both still accept these, so they move from the majority camp to the
  // minority one, which is the same trade the non-ISO formats above make.
  //
  // js's own tests carried `2025-01-01t00:00:00z` from the SDK's first commit (#36);
  // those operands were incidental to what each test asserts and are now uppercase.
  it.each([
    ['2025-01-01t00:00:00z', 'both designators lowercase'],
    ['2025-01-01t00:00:00Z', 'lowercase separator'],
    ['2025-01-01T00:00:00z', 'lowercase zone designator'],
  ])('rejects %j (%s)', (operand) => {
    expect(unparseable(operand)).toBe(true);
  });

  it.each(['2024-01-01T24:00:00', '2024-01-01T25:00:00Z', '2024-01-01 99:00'])(
    'rejects the out-of-range hour %j rather than rolling it over',
    (operand) => {
      // The engine's DateTimeOffset.TryParse rejects hour 24 outright; Date.parse
      // rolled it to 00:00 the NEXT day, so this used to be 2024-01-02 in js alone.
      expect(unparseable(operand)).toBe(true);
    },
  );
});

afterEach(() => {
  process.env.TZ = 'UTC';
});
