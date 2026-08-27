import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { evaluate, evaluateWithSharedMemo } from '../src/core/evaluator.js';
import type {
  EvaluationContext,
  EvaluationDetail,
  FlagDto,
} from '../src/core/types.js';

function md5(input: string): Uint8Array {
  return createHash('md5').update(input, 'utf8').digest();
}

const deps = { md5, getSegment: () => undefined };

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

const ctx: EvaluationContext = { user_id: 'user-1' };

// --- Prerequisite resolution ---

describe('evaluate with prerequisites', () => {
  it('passes through when no prerequisites defined', () => {
    const flag = makeFlag({ key: 'main', prerequisites: [] });
    const result = evaluate(flag, ctx, deps, {});
    expect(result.reason).toBe('Fallthrough');
    expect(result.value).toBe(true);
  });

  it('serves on variation when prerequisite is satisfied', () => {
    const prereqFlag = makeFlag({
      key: 'prereq',
      fallthrough: { type: 'Fixed', variation: 'on' },
    });
    const mainFlag = makeFlag({
      key: 'main',
      prerequisites: [
        { prerequisiteFlagKey: 'prereq', expectedVariationKey: 'on' },
      ],
    });
    const allFlags: Record<string, FlagDto> = { prereq: prereqFlag };
    const result = evaluate(mainFlag, ctx, deps, allFlags);
    expect(result.reason).toBe('Fallthrough');
    expect(result.value).toBe(true);
    expect(result.prerequisiteKey).toBeUndefined();
  });

  it('serves off variation when prerequisite is not satisfied', () => {
    const prereqFlag = makeFlag({
      key: 'prereq',
      fallthrough: { type: 'Fixed', variation: 'off' },
    });
    const mainFlag = makeFlag({
      key: 'main',
      prerequisites: [
        { prerequisiteFlagKey: 'prereq', expectedVariationKey: 'on' },
      ],
    });
    const allFlags: Record<string, FlagDto> = { prereq: prereqFlag };
    const result = evaluate(mainFlag, ctx, deps, allFlags);
    expect(result.reason).toBe('PrerequisiteFailed');
    expect(result.variationKey).toBe('off');
    expect(result.prerequisiteKey).toBe('prereq');
  });

  it('serves off variation when prerequisite flag is disabled', () => {
    const prereqFlag = makeFlag({
      key: 'prereq',
      enabled: false,
      offVariation: 'off',
    });
    // prereq flag is disabled → evaluates to 'off'. expected is 'on' → fails.
    const mainFlag = makeFlag({
      key: 'main',
      prerequisites: [
        { prerequisiteFlagKey: 'prereq', expectedVariationKey: 'on' },
      ],
    });
    const allFlags: Record<string, FlagDto> = { prereq: prereqFlag };
    const result = evaluate(mainFlag, ctx, deps, allFlags);
    expect(result.reason).toBe('PrerequisiteFailed');
    expect(result.variationKey).toBe('off');
    expect(result.prerequisiteKey).toBe('prereq');
  });

  it('reports first failing prerequisite key when multiple prerequisites fail', () => {
    const prereqA = makeFlag({
      key: 'prereq-a',
      fallthrough: { type: 'Fixed', variation: 'off' }, // fails
    });
    const prereqB = makeFlag({
      key: 'prereq-b',
      fallthrough: { type: 'Fixed', variation: 'off' }, // also fails
    });
    const mainFlag = makeFlag({
      key: 'main',
      prerequisites: [
        { prerequisiteFlagKey: 'prereq-a', expectedVariationKey: 'on' },
        { prerequisiteFlagKey: 'prereq-b', expectedVariationKey: 'on' },
      ],
    });
    const allFlags: Record<string, FlagDto> = {
      'prereq-a': prereqA,
      'prereq-b': prereqB,
    };
    const result = evaluate(mainFlag, ctx, deps, allFlags);
    expect(result.reason).toBe('PrerequisiteFailed');
    // First prerequisite in the list is reported
    expect(result.prerequisiteKey).toBe('prereq-a');
  });

  it('resolves chained prerequisites (prereq of prereq)', () => {
    // grandchild must be 'on' for child to serve 'on', for main to evaluate
    const grandchildFlag = makeFlag({
      key: 'grandchild',
      fallthrough: { type: 'Fixed', variation: 'on' },
    });
    const childFlag = makeFlag({
      key: 'child',
      prerequisites: [
        { prerequisiteFlagKey: 'grandchild', expectedVariationKey: 'on' },
      ],
      fallthrough: { type: 'Fixed', variation: 'on' },
    });
    const mainFlag = makeFlag({
      key: 'main',
      prerequisites: [
        { prerequisiteFlagKey: 'child', expectedVariationKey: 'on' },
      ],
    });
    const allFlags: Record<string, FlagDto> = {
      grandchild: grandchildFlag,
      child: childFlag,
    };
    // Chain satisfied → main should fall through
    const result = evaluate(mainFlag, ctx, deps, allFlags);
    expect(result.reason).toBe('Fallthrough');
    expect(result.value).toBe(true);

    // Now break the chain at the grandchild level
    const grandchildFailing = makeFlag({
      key: 'grandchild',
      fallthrough: { type: 'Fixed', variation: 'off' },
    });
    const allFlagsFailing: Record<string, FlagDto> = {
      grandchild: grandchildFailing,
      child: childFlag,
    };
    const result2 = evaluate(mainFlag, ctx, deps, allFlagsFailing);
    expect(result2.reason).toBe('PrerequisiteFailed');
  });

  it('serves off safely when prerequisite flag is missing from allFlags', () => {
    const mainFlag = makeFlag({
      key: 'main',
      prerequisites: [
        { prerequisiteFlagKey: 'missing-flag', expectedVariationKey: 'on' },
      ],
    });
    const result = evaluate(mainFlag, ctx, deps, {});
    expect(result.reason).toBe('PrerequisiteFailed');
    expect(result.variationKey).toBe('off');
    expect(result.prerequisiteKey).toBe('missing-flag');
  });

  it('returns Error reason when maximum prerequisite depth is exceeded', () => {
    // Build a linear chain of 12 flags (exceeds MAX_PREREQUISITE_DEPTH = 10)
    const flags: Record<string, FlagDto> = {};
    for (let i = 0; i < 12; i++) {
      const key = `flag-${i}`;
      const prereqs =
        i > 0
          ? [{ prerequisiteFlagKey: `flag-${i - 1}`, expectedVariationKey: 'on' }]
          : [];
      flags[key] = makeFlag({
        key,
        prerequisites: prereqs,
        fallthrough: { type: 'Fixed', variation: 'on' },
      });
    }
    const topFlag = flags['flag-11']!;
    const result = evaluate(topFlag, ctx, deps, flags);
    expect(result.reason).toBe('Error');
  });
});

describe('evaluateWithSharedMemo', () => {
  it('uses provided memo to avoid redundant re-evaluation', () => {
    const prereqFlag = makeFlag({
      key: 'prereq',
      fallthrough: { type: 'Fixed', variation: 'on' },
    });
    const mainFlag = makeFlag({
      key: 'main',
      prerequisites: [
        { prerequisiteFlagKey: 'prereq', expectedVariationKey: 'on' },
      ],
    });
    const allFlags: Record<string, FlagDto> = { prereq: prereqFlag };

    // Pre-populate memo with a memoized result for prereq
    const memo = new Map<string, EvaluationDetail>();
    memo.set('prereq', {
      value: true,
      variationKey: 'on',
      reason: 'Fallthrough',
    });

    const result = evaluateWithSharedMemo(mainFlag, ctx, deps, allFlags, memo);
    expect(result.reason).toBe('Fallthrough');
    // memo should now include 'main' too
    expect(memo.has('main')).toBe(true);
  });
});
