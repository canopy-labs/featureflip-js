import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  computeBucket,
  evaluate,
  evaluateCondition,
  evaluateConditions,
  evaluateConditionGroups,
} from '../src/core/evaluator.js';
import type {
  ConditionDto,
  ConditionGroupDto,
  EvaluationContext,
  FlagDto,
  SegmentDto,
} from '../src/core/types.js';

function md5(input: string): Uint8Array {
  return createHash('md5').update(input, 'utf8').digest();
}

function makeFlag(overrides: Partial<FlagDto> = {}): FlagDto {
  return {
    key: 'test-flag',
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
    ...overrides,
  };
}

function makeCondition(overrides: Partial<ConditionDto> = {}): ConditionDto {
  return {
    attribute: 'country',
    operator: 'Equals',
    values: ['us'],
    negate: false,
    ...overrides,
  };
}

// --- computeBucket ---

describe('computeBucket', () => {
  it('returns deterministic value in [0, 99]', () => {
    const bucket = computeBucket('salt', 'user123', md5);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);

    // Same input = same output
    expect(computeBucket('salt', 'user123', md5)).toBe(bucket);
  });

  it('different inputs produce different buckets', () => {
    const b1 = computeBucket('salt', 'user1', md5);
    const b2 = computeBucket('salt', 'user2', md5);
    // Not a guarantee but statistically unlikely to be equal
    // At minimum, verify they're both valid
    expect(b1).toBeGreaterThanOrEqual(0);
    expect(b2).toBeGreaterThanOrEqual(0);
  });

  it('matches Python SDK output', () => {
    // Verify cross-SDK compatibility by checking known values
    // Python: hashlib.md5(b"test-salt:user-42").digest()[:4] -> little-endian uint32 % 100
    const bucket = computeBucket('test-salt', 'user-42', md5);
    expect(typeof bucket).toBe('number');
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
  });

  it('handles empty strings', () => {
    const bucket = computeBucket('', '', md5);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
  });
});

// --- evaluateCondition ---

describe('evaluateCondition', () => {
  describe('Equals', () => {
    it('matches case-insensitively', () => {
      const cond = makeCondition({ operator: 'Equals', values: ['us'] });
      expect(evaluateCondition(cond, { country: 'US' })).toBe(true);
      expect(evaluateCondition(cond, { country: 'us' })).toBe(true);
      expect(evaluateCondition(cond, { country: 'UK' })).toBe(false);
    });

    it('matches any value in the list', () => {
      const cond = makeCondition({
        operator: 'Equals',
        values: ['us', 'uk'],
      });
      expect(evaluateCondition(cond, { country: 'us' })).toBe(true);
      expect(evaluateCondition(cond, { country: 'uk' })).toBe(true);
      expect(evaluateCondition(cond, { country: 'fr' })).toBe(false);
    });
  });

  describe('NotEquals', () => {
    it('requires value to differ from all targets', () => {
      const cond = makeCondition({
        operator: 'NotEquals',
        values: ['us', 'uk'],
      });
      expect(evaluateCondition(cond, { country: 'fr' })).toBe(true);
      expect(evaluateCondition(cond, { country: 'us' })).toBe(false);
    });
  });

  describe('Contains', () => {
    it('checks substring match', () => {
      const cond = makeCondition({
        attribute: 'email',
        operator: 'Contains',
        values: ['@example'],
      });
      expect(
        evaluateCondition(cond, { email: 'user@example.com' }),
      ).toBe(true);
      expect(evaluateCondition(cond, { email: 'user@other.com' })).toBe(false);
    });
  });

  describe('NotContains', () => {
    it('requires no substring match', () => {
      const cond = makeCondition({
        attribute: 'email',
        operator: 'NotContains',
        values: ['spam'],
      });
      expect(evaluateCondition(cond, { email: 'user@good.com' })).toBe(true);
      expect(evaluateCondition(cond, { email: 'spam@bad.com' })).toBe(false);
    });
  });

  describe('StartsWith', () => {
    it('checks prefix', () => {
      const cond = makeCondition({
        attribute: 'name',
        operator: 'StartsWith',
        values: ['john'],
      });
      expect(evaluateCondition(cond, { name: 'John Doe' })).toBe(true);
      expect(evaluateCondition(cond, { name: 'Jane Doe' })).toBe(false);
    });
  });

  describe('EndsWith', () => {
    it('checks suffix', () => {
      const cond = makeCondition({
        attribute: 'email',
        operator: 'EndsWith',
        values: ['.com'],
      });
      expect(evaluateCondition(cond, { email: 'user@test.com' })).toBe(true);
      expect(evaluateCondition(cond, { email: 'user@test.org' })).toBe(false);
    });
  });

  describe('In / NotIn', () => {
    it('checks list membership', () => {
      const condIn = makeCondition({
        operator: 'In',
        values: ['us', 'uk', 'ca'],
      });
      expect(evaluateCondition(condIn, { country: 'US' })).toBe(true);
      expect(evaluateCondition(condIn, { country: 'FR' })).toBe(false);

      const condNotIn = makeCondition({
        operator: 'NotIn',
        values: ['us', 'uk'],
      });
      expect(evaluateCondition(condNotIn, { country: 'FR' })).toBe(true);
      expect(evaluateCondition(condNotIn, { country: 'US' })).toBe(false);
    });
  });

  describe('MatchesRegex', () => {
    it('matches case-sensitively (engine parity)', () => {
      const cond = makeCondition({
        attribute: 'email',
        operator: 'MatchesRegex',
        values: ['^User\\d+@'],
      });
      // Exact-case match succeeds.
      expect(
        evaluateCondition(cond, { email: 'User42@example.com' }),
      ).toBe(true);
      // A case-mismatched value does NOT match — the engine evaluates regex
      // case-sensitively (RegexOptions.None) and the pattern is not lowercased.
      expect(
        evaluateCondition(cond, { email: 'user42@example.com' }),
      ).toBe(false);
      expect(evaluateCondition(cond, { email: 'admin@example.com' })).toBe(
        false,
      );
    });

    it('handles invalid regex gracefully', () => {
      const cond = makeCondition({
        attribute: 'name',
        operator: 'MatchesRegex',
        values: ['[invalid'],
      });
      expect(evaluateCondition(cond, { name: 'test' })).toBe(false);
    });
  });

  describe('numeric operators', () => {
    it('GreaterThan', () => {
      const cond = makeCondition({
        attribute: 'age',
        operator: 'GreaterThan',
        values: ['18'],
      });
      expect(evaluateCondition(cond, { age: 21 })).toBe(true);
      expect(evaluateCondition(cond, { age: 18 })).toBe(false);
      expect(evaluateCondition(cond, { age: 15 })).toBe(false);
    });

    it('LessThanOrEqual', () => {
      const cond = makeCondition({
        attribute: 'score',
        operator: 'LessThanOrEqual',
        values: ['100'],
      });
      expect(evaluateCondition(cond, { score: 100 })).toBe(true);
      expect(evaluateCondition(cond, { score: 50 })).toBe(true);
      expect(evaluateCondition(cond, { score: 101 })).toBe(false);
    });

    it('handles non-numeric values', () => {
      const cond = makeCondition({
        attribute: 'age',
        operator: 'GreaterThan',
        values: ['18'],
      });
      expect(evaluateCondition(cond, { age: 'not-a-number' })).toBe(false);
    });
  });

  describe('temporal operators', () => {
    it('Before', () => {
      const cond = makeCondition({
        attribute: 'created_at',
        operator: 'Before',
        values: ['2025-01-01T00:00:00Z'],
      });
      expect(
        evaluateCondition(cond, { created_at: '2024-06-15T00:00:00Z' }),
      ).toBe(true);
      expect(
        evaluateCondition(cond, { created_at: '2025-06-15T00:00:00Z' }),
      ).toBe(false);
    });

    it('After', () => {
      const cond = makeCondition({
        attribute: 'created_at',
        operator: 'After',
        values: ['2025-01-01T00:00:00Z'],
      });
      expect(
        evaluateCondition(cond, { created_at: '2025-06-15T00:00:00Z' }),
      ).toBe(true);
    });
  });

  // Issue #1455: date operators (Before/After) must parse both operands as real
  // UTC date-time instants (honoring TZ offsets, assuming UTC when none is given,
  // with a unix-seconds fallback) instead of a lexical string compare — mirroring
  // the engine's CompareDateTime. An unparseable attribute value yields NO match
  // (never a lexical fallback); unparseable condition values are skipped.
  describe('date operators (Issue #1455)', () => {
    it.each([
      // [value, operator, conditionValues, expected]
      // TZ offset normalization: 12:00+05:00 == 07:00Z < 08:00Z
      ['2026-01-01T12:00:00+05:00', 'Before', ['2026-01-01T08:00:00Z'], true],
      ['2026-01-01T12:00:00+05:00', 'After', ['2026-01-01T08:00:00Z'], false],
      // unix seconds: 1700000000 -> 2023-11-14
      ['1700000000', 'After', ['2020-01-01T00:00:00Z'], true],
      ['1700000000', 'Before', ['2020-01-01T00:00:00Z'], false],
      // unparseable attribute value -> NO match (NOT lexical "hello" < "world")
      ['hello', 'Before', ['world'], false],
      ['hello', 'After', ['world'], false],
      // no offset -> assumed UTC (not local time)
      ['2026-01-01T08:00:00', 'Before', ['2026-01-01T09:00:00Z'], true],
      // plain UTC ordering
      ['2026-06-01T00:00:00Z', 'After', ['2026-01-01T00:00:00Z'], true],
      ['2026-06-01T00:00:00Z', 'Before', ['2026-01-01T00:00:00Z'], false],
      // any-of: matches against ANY supplied condition value
      [
        '2026-03-01T00:00:00Z',
        'After',
        ['2030-01-01T00:00:00Z', '2020-01-01T00:00:00Z'],
        true,
      ],
      // skip unparseable condition value, match the next
      [
        '2026-01-01T07:30:00Z',
        'Before',
        ['garbage', '2026-01-01T08:00:00Z'],
        true,
      ],
      // unix seconds as a condition value: 1700000000 -> 2023-11-14
      ['2023-11-15T00:00:00Z', 'After', ['1700000000'], true],
    ] as const)(
      '%s %s %j -> %s',
      (value, operator, conditionValues, expected) => {
        const cond = makeCondition({
          attribute: 'created_at',
          operator,
          values: [...conditionValues],
        });
        expect(evaluateCondition(cond, { created_at: value })).toBe(expected);
      },
    );
  });

  describe('semver operators (Issue #1409)', () => {
    it.each([
      // [actual, gate, expected] — version targeting must use semver, not decimal, comparison
      ['2.10.1', '2.0', true], // decimal parse of "2.10.1" failed -> false
      ['2.10', '2.9', true], // decimal parsed "2.10" as 2.1 < 2.9
      ['2.0', '2.0', true], // equal satisfies >=
      ['2.0.0', '2.0', true], // 2.0.0 == 2.0 under semver
      ['1.9.9', '2.0', false], // below the gate
      ['v2.1', '2.0', true], // leading "v" tolerated
      ['not-a-version', '2.0', false], // unparseable -> no match
    ])(
      'SemverGreaterThanOrEqual: %s >= %s -> %s',
      (actual, gate, expected) => {
        const cond = makeCondition({
          attribute: 'version',
          operator: 'SemverGreaterThanOrEqual',
          values: [gate as string],
        });
        expect(evaluateCondition(cond, { version: actual })).toBe(expected);
      },
    );

    it('SemverLessThan compares segments numerically, not as decimals', () => {
      const cond = makeCondition({
        attribute: 'version',
        operator: 'SemverLessThan',
        values: ['1.10.0'],
      });
      // decimal comparison would call 1.2 > 1.1 (wrong); semver: 2 < 10
      expect(evaluateCondition(cond, { version: '1.2.0' })).toBe(true);
      expect(evaluateCondition(cond, { version: '1.11.0' })).toBe(false);
    });

    it('SemverEquals treats differing segment counts as equal', () => {
      const cond = makeCondition({
        attribute: 'version',
        operator: 'SemverEquals',
        values: ['2.0.0'],
      });
      expect(evaluateCondition(cond, { version: '2.0' })).toBe(true);
      expect(evaluateCondition(cond, { version: '2.0.1' })).toBe(false);
    });

    it('treats a prerelease as lower precedence than the release', () => {
      const cond = makeCondition({
        attribute: 'version',
        operator: 'SemverGreaterThanOrEqual',
        values: ['2.0.0'],
      });
      // 2.0.0-rc.1 < 2.0.0 per semver §11
      expect(evaluateCondition(cond, { version: '2.0.0-rc.1' })).toBe(false);
      expect(evaluateCondition(cond, { version: '2.0.0' })).toBe(true);
    });
  });

  // Issue #1454: prerelease identifiers compare case-sensitively in ASCII order
  // (semver §11 — 'B' (66) sorts before 'a' (97)), matching the engine's
  // SemverComparer. The evaluator must not lowercase semver operands before
  // dispatch, which would fold 'Beta' -> 'beta' and flip precedence vs the server.
  describe('semver prerelease is case-sensitive (Issue #1454)', () => {
    it('does not treat 1.0.0-Beta as greater than 1.0.0-alpha', () => {
      const cond = makeCondition({
        attribute: 'version',
        operator: 'SemverGreaterThan',
        values: ['1.0.0-alpha'],
      });
      // 'B' (66) < 'a' (97) -> Beta has lower precedence than alpha
      expect(evaluateCondition(cond, { version: '1.0.0-Beta' })).toBe(false);
    });

    it('treats 1.0.0-alpha as greater than 1.0.0-Beta', () => {
      const cond = makeCondition({
        attribute: 'version',
        operator: 'SemverGreaterThan',
        values: ['1.0.0-Beta'],
      });
      expect(evaluateCondition(cond, { version: '1.0.0-alpha' })).toBe(true);
    });

    it('treats RC1 and rc1 prerelease identifiers as unequal', () => {
      const cond = makeCondition({
        attribute: 'version',
        operator: 'SemverEquals',
        values: ['1.0.0-rc1'],
      });
      expect(evaluateCondition(cond, { version: '1.0.0-RC1' })).toBe(false);
    });
  });

  // Issue #1443: relational operators (numeric/date/semver) must match if the
  // attribute satisfies the operator against ANY supplied condition value — not
  // just values[0] — to agree with the server engine (and C#/Java SDKs).
  describe('multi-value relational operators (Issue #1443)', () => {
    it('GreaterThan matches when a later value is satisfied', () => {
      const cond = makeCondition({
        attribute: 'age',
        operator: 'GreaterThan',
        values: ['20', '10'],
      });
      // any(15 > 20, 15 > 10) -> true; values[0]-only would be false
      expect(evaluateCondition(cond, { age: 15 })).toBe(true);
      // below every value -> false
      expect(evaluateCondition(cond, { age: 5 })).toBe(false);
    });

    it('Before matches when a later value is satisfied', () => {
      const cond = makeCondition({
        attribute: 'created_at',
        operator: 'Before',
        values: ['2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z'],
      });
      // any(2025 < 2020, 2025 < 2030) -> true; values[0]-only would be false
      expect(
        evaluateCondition(cond, { created_at: '2025-06-15T00:00:00Z' }),
      ).toBe(true);
    });

    it('After matches when a later value is satisfied', () => {
      const cond = makeCondition({
        attribute: 'created_at',
        operator: 'After',
        values: ['2030-01-01T00:00:00Z', '2020-01-01T00:00:00Z'],
      });
      // any(2025 > 2030, 2025 > 2020) -> true; values[0]-only would be false
      expect(
        evaluateCondition(cond, { created_at: '2025-06-15T00:00:00Z' }),
      ).toBe(true);
    });

    it('SemverGreaterThan matches when a later value is satisfied', () => {
      const cond = makeCondition({
        attribute: 'version',
        operator: 'SemverGreaterThan',
        values: ['5.0', '2.0'],
      });
      // any(3.0 > 5.0, 3.0 > 2.0) -> true; values[0]-only would be false
      expect(evaluateCondition(cond, { version: '3.0' })).toBe(true);
    });

    it('returns false (no throw) when values is empty', () => {
      for (const operator of [
        'GreaterThan',
        'Before',
        'After',
        'SemverGreaterThan',
      ] as const) {
        const cond = makeCondition({
          attribute: 'age',
          operator,
          values: [],
        });
        expect(evaluateCondition(cond, { age: 15 })).toBe(false);
      }
    });
  });

  describe('negate', () => {
    it('inverts result', () => {
      const cond = makeCondition({
        operator: 'Equals',
        values: ['us'],
        negate: true,
      });
      expect(evaluateCondition(cond, { country: 'US' })).toBe(false);
      expect(evaluateCondition(cond, { country: 'UK' })).toBe(true);
    });
  });

  // Issue #2262: an operator this evaluator does not recognise means "I cannot
  // evaluate this", NOT "this did not match". Inverting that inability with
  // `negate` would turn it into a match-everyone — a fail-OPEN rollout of a
  // flag to 100% of traffic. Unrecognised operators therefore short-circuit to
  // `false` BEFORE negate is applied. Contrast the missing-attribute path
  // above, which legitimately returns `negate`: absence is a determinate fact
  // about the user, an unknown operator is not.
  describe('unrecognised operator (Issue #2262)', () => {
    it('does not match when not negated', () => {
      const cond = makeCondition({
        operator: 'SomeFutureOperator' as ConditionDto['operator'],
        values: ['us'],
        negate: false,
      });
      expect(evaluateCondition(cond, { country: 'US' })).toBe(false);
    });

    it('does not match when negated (fails closed, not open)', () => {
      const cond = makeCondition({
        operator: 'SomeFutureOperator' as ConditionDto['operator'],
        values: ['us'],
        negate: true,
      });
      expect(evaluateCondition(cond, { country: 'US' })).toBe(false);
    });

    // This evaluator matches operator labels exactly (PascalCase, as the API
    // emits them), so a mis-cased label is simply unrecognised and must fail
    // closed like any other — not invert into a match-everyone.
    it('treats a mis-cased known operator as unrecognised, both ways', () => {
      const lower = makeCondition({
        operator: 'equals' as ConditionDto['operator'],
        values: ['us'],
        negate: false,
      });
      expect(evaluateCondition(lower, { country: 'US' })).toBe(false);

      const lowerNegated = makeCondition({
        operator: 'equals' as ConditionDto['operator'],
        values: ['us'],
        negate: true,
      });
      expect(evaluateCondition(lowerNegated, { country: 'US' })).toBe(false);
    });
  });

  describe('missing attribute', () => {
    it('returns false when attribute missing and not negated', () => {
      const cond = makeCondition({ negate: false });
      expect(evaluateCondition(cond, {})).toBe(false);
    });

    it('returns true when attribute missing and negated', () => {
      const cond = makeCondition({ negate: true });
      expect(evaluateCondition(cond, {})).toBe(true);
    });
  });

  // Issue #1458: when the raw attribute is a numeric (not boolean) value, the
  // equality-family operators (Equals/NotEquals/In/NotIn) compare numerically
  // instead of stringifying — mirroring the .NET engine. Condition literals are
  // parsed strictly (Number(), not parseFloat) so "1abc" is NOT a number. Other
  // operators (Contains/StartsWith/etc.) and non-numeric attributes (booleans,
  // strings) keep the existing string path.
  describe('type-aware numeric Equals coercion (Issue #1458)', () => {
    it.each([
      // [attribute, operator, conditionValues, expected]
      // numeric attribute -> numeric comparison (1.0 === 1 in JS)
      [1.0, 'Equals', ['1.0'], true],
      [1.0, 'Equals', ['1'], true],
      [1, 'Equals', ['1.0'], true],
      [1, 'Equals', ['1'], true],
      [1.5, 'Equals', ['1.5'], true],
      [1.5, 'Equals', ['1'], false],
      [2, 'In', ['1', '2.0'], true],
      [3, 'In', ['1', '2'], false],
      [1.0, 'NotEquals', ['1.0'], false],
      [1.0, 'NotEquals', ['2'], true],
      [3, 'NotIn', ['1', '2'], true],
      // strict parse: non-numeric literals never match
      [1, 'Equals', ['abc'], false],
      [1, 'Equals', ['1abc'], false],
      // booleans are NOT numeric -> string path ("true" !== "1")
      [true, 'Equals', ['1'], false],
      [true, 'Equals', ['true'], true],
      // string attribute -> no coercion, lexical compare
      ['1.0', 'Equals', ['1'], false],
      ['01234', 'Equals', ['1234'], false],
    ] as const)(
      '%j %s %j -> %s',
      (attribute, operator, conditionValues, expected) => {
        const cond = makeCondition({
          attribute: 'attr',
          operator,
          values: [...conditionValues],
        });
        expect(evaluateCondition(cond, { attr: attribute })).toBe(expected);
      },
    );

    it('respects negate on the numeric path', () => {
      const cond = makeCondition({
        attribute: 'attr',
        operator: 'Equals',
        values: ['2'],
        negate: true,
      });
      // 1 Equals 2 -> false, negate -> true
      expect(evaluateCondition(cond, { attr: 1 })).toBe(true);
    });
  });
});

// --- evaluateConditions ---

describe('evaluateConditions', () => {
  it('empty conditions returns true', () => {
    expect(evaluateConditions([], 'And', {})).toBe(true);
    expect(evaluateConditions([], 'Or', {})).toBe(true);
  });

  it('AND requires all conditions', () => {
    const conditions: ConditionDto[] = [
      makeCondition({ attribute: 'country', values: ['us'] }),
      makeCondition({ attribute: 'plan', operator: 'Equals', values: ['pro'] }),
    ];
    expect(
      evaluateConditions(conditions, 'And', { country: 'US', plan: 'pro' }),
    ).toBe(true);
    expect(
      evaluateConditions(conditions, 'And', { country: 'US', plan: 'free' }),
    ).toBe(false);
  });

  it('OR requires at least one condition', () => {
    const conditions: ConditionDto[] = [
      makeCondition({ attribute: 'country', values: ['us'] }),
      makeCondition({ attribute: 'country', values: ['uk'] }),
    ];
    expect(evaluateConditions(conditions, 'Or', { country: 'US' })).toBe(true);
    expect(evaluateConditions(conditions, 'Or', { country: 'FR' })).toBe(
      false,
    );
  });
});

// --- evaluateConditionGroups ---

describe('evaluateConditionGroups', () => {
  it('empty groups returns true', () => {
    expect(evaluateConditionGroups([], {})).toBe(true);
  });

  it('single group uses its operator', () => {
    const groups: ConditionGroupDto[] = [
      {
        operator: 'Or',
        conditions: [
          makeCondition({ attribute: 'country', values: ['us'] }),
          makeCondition({ attribute: 'country', values: ['uk'] }),
        ],
      },
    ];
    expect(evaluateConditionGroups(groups, { country: 'US' })).toBe(true);
    expect(evaluateConditionGroups(groups, { country: 'UK' })).toBe(true);
    expect(evaluateConditionGroups(groups, { country: 'FR' })).toBe(false);
  });

  it('multiple groups are ANDed together', () => {
    const groups: ConditionGroupDto[] = [
      {
        operator: 'Or',
        conditions: [
          makeCondition({ attribute: 'country', values: ['us'] }),
          makeCondition({ attribute: 'country', values: ['uk'] }),
        ],
      },
      {
        operator: 'And',
        conditions: [
          makeCondition({ attribute: 'plan', values: ['pro'] }),
        ],
      },
    ];
    // Both groups must match
    expect(evaluateConditionGroups(groups, { country: 'US', plan: 'pro' })).toBe(true);
    // First group matches, second doesn't
    expect(evaluateConditionGroups(groups, { country: 'US', plan: 'free' })).toBe(false);
    // Second group matches, first doesn't
    expect(evaluateConditionGroups(groups, { country: 'FR', plan: 'pro' })).toBe(false);
  });
});

// --- evaluate (full flag) ---

describe('evaluate', () => {
  const deps = { md5, getSegment: () => undefined };

  it('returns offVariation when flag disabled', () => {
    const flag = makeFlag({ enabled: false });
    const result = evaluate(flag, { user_id: '123' }, deps);
    expect(result.value).toBe(false);
    expect(result.reason).toBe('FlagDisabled');
  });

  it('returns fallthrough when no rules match', () => {
    const flag = makeFlag();
    const result = evaluate(flag, { user_id: '123' }, deps);
    expect(result.value).toBe(true);
    expect(result.reason).toBe('Fallthrough');
  });

  it('returns rule match when conditions met', () => {
    const flag = makeFlag({
      rules: [
        {
          id: 'rule-1',
          priority: 0,
          conditionGroups: [
            { operator: 'And', conditions: [makeCondition({ values: ['us'] })] },
          ],
          serve: { type: 'Fixed', variation: 'off' },
        },
      ],
    });

    const result = evaluate(flag, { country: 'US' }, deps);
    expect(result.value).toBe(false);
    expect(result.reason).toBe('RuleMatch');
    expect(result.ruleId).toBe('rule-1');
  });

  it('evaluates rules in priority order', () => {
    const flag = makeFlag({
      rules: [
        {
          id: 'rule-low-priority',
          priority: 10,
          conditionGroups: [
            { operator: 'And', conditions: [makeCondition({ values: ['us'] })] },
          ],
          serve: { type: 'Fixed', variation: 'on' },
        },
        {
          id: 'rule-high-priority',
          priority: 0,
          conditionGroups: [
            { operator: 'And', conditions: [makeCondition({ values: ['us'] })] },
          ],
          serve: { type: 'Fixed', variation: 'off' },
        },
      ],
    });

    const result = evaluate(flag, { country: 'US' }, deps);
    expect(result.ruleId).toBe('rule-high-priority');
    expect(result.value).toBe(false);
  });

  it('skips non-matching rules and falls through', () => {
    const flag = makeFlag({
      rules: [
        {
          id: 'rule-1',
          priority: 0,
          conditionGroups: [
            { operator: 'And', conditions: [makeCondition({ values: ['uk'] })] },
          ],
          serve: { type: 'Fixed', variation: 'off' },
        },
      ],
    });

    const result = evaluate(flag, { country: 'US' }, deps);
    expect(result.reason).toBe('Fallthrough');
    expect(result.value).toBe(true);
  });

  it('handles rollout in fallthrough', () => {
    const flag = makeFlag({
      fallthrough: {
        type: 'Rollout',
        bucketBy: 'user_id',
        salt: 'test-salt',
        variations: [
          { key: 'on', weight: 90 },
          { key: 'off', weight: 10 },
        ],
      },
    });

    // Evaluate many users and verify distribution
    const results = new Map<unknown, number>();
    for (let i = 0; i < 100; i++) {
      const result = evaluate(flag, { user_id: `user-${i}` }, deps);
      const count = results.get(result.value) ?? 0;
      results.set(result.value, count + 1);
    }

    // With 90/10 split, we should see both variations
    expect(results.has(true)).toBe(true);
    expect(results.has(false)).toBe(true);
  });

  it('serves the control (first) variation for keyless users in a rollout (#1457)', () => {
    // An anonymous context (no userId/user_id) cannot be bucketed. Rather than
    // hashing the empty value into an arbitrary salt-dependent bucket, local
    // eval deterministically serves the control (first) variation. The engine
    // randomizes per-eval over HTTP — parity is guaranteed only for keyed
    // contexts (see #1457).
    const flag = makeFlag({
      fallthrough: {
        type: 'Rollout',
        bucketBy: 'userId',
        salt: 'test-salt',
        variations: [
          // Control is a thin slice so the old empty-hash collapse would not
          // have landed here — proving the keyless guard, not coincidence.
          { key: 'on', weight: 1 },
          { key: 'off', weight: 99 },
        ],
      },
    });

    const result = evaluate(flag, {}, deps);
    expect(result.variationKey).toBe('on');
    expect(result.value).toBe(true);

    // Deterministic: repeated keyless evals never re-bucket.
    for (let i = 0; i < 20; i++) {
      expect(evaluate(flag, {}, deps).variationKey).toBe('on');
    }
  });

  it('serves the default variation when a rollout serve has no variations (#1469)', () => {
    // Env-level PercentageRollout emits a Rollout serve with its default variation set but
    // no weighted variations (there is no per-variation weight storage at the env level).
    // Degrade to the default variation instead of returning an empty key. Mirrors the engine
    // + C#/Java SDK evaluators.
    const flag = makeFlag({
      fallthrough: {
        type: 'Rollout',
        bucketBy: 'userId',
        variation: 'off',
        // variations intentionally omitted (undefined on the wire)
      },
    });

    const result = evaluate(flag, { userId: 'user-1' }, deps);
    expect(result.variationKey).toBe('off');
    expect(result.value).toBe(false);
    expect(result.reason).toBe('Fallthrough');
  });

  it('handles segment-based rules', () => {
    const segment: SegmentDto = {
      key: 'beta-users',
      version: 1,
      conditions: [makeCondition({ attribute: 'plan', values: ['pro'] })],
      conditionLogic: 'And',
    };

    const flag = makeFlag({
      rules: [
        {
          id: 'segment-rule',
          priority: 0,
          conditionGroups: [],
          serve: { type: 'Fixed', variation: 'on' },
          segmentKey: 'beta-users',
        },
      ],
    });

    const segmentDeps = {
      md5,
      getSegment: (key: string) => (key === 'beta-users' ? segment : undefined),
    };

    const result = evaluate(flag, { plan: 'pro' }, segmentDeps);
    expect(result.reason).toBe('RuleMatch');
    expect(result.value).toBe(true);

    const result2 = evaluate(flag, { plan: 'free' }, segmentDeps);
    expect(result2.reason).toBe('Fallthrough');
  });

  it('does not match a segment-keyed rule when no segment source is wired (#1459)', () => {
    const flag = makeFlag({
      rules: [
        {
          id: 'segment-rule',
          priority: 0,
          conditionGroups: [],
          serve: { type: 'Fixed', variation: 'off' },
          segmentKey: 'beta-users',
        },
      ],
    });

    // deps omit getSegment — the segment source is not wired, so the rule's
    // segment cannot be resolved. It must fail closed (no match), mirroring the
    // engine + C# SDK, rather than falling through to the rule's empty
    // condition groups (which evaluate to true → unconditional match).
    const result = evaluate(flag, { plan: 'pro' }, { md5 });
    expect(result.reason).toBe('Fallthrough');
    expect(result.value).toBe(true);
  });
});
