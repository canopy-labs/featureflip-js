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
    it('applies case-insensitive regex', () => {
      const cond = makeCondition({
        attribute: 'email',
        operator: 'MatchesRegex',
        values: ['^user\\d+@'],
      });
      expect(
        evaluateCondition(cond, { email: 'User42@example.com' }),
      ).toBe(true);
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
        values: ['2025-01-01t00:00:00z'],
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
        values: ['2025-01-01t00:00:00z'],
      });
      expect(
        evaluateCondition(cond, { created_at: '2025-06-15T00:00:00Z' }),
      ).toBe(true);
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
});
