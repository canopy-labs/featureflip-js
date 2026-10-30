import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { evaluate } from '../src/core/evaluator.js';
import type { FlagDto } from '../src/core/types.js';

const md5 = (input: string) => createHash('md5').update(input, 'utf8').digest();

// r1 rolls out on `groups` (100% "on"); r2 serves "fb" to everyone. A value r1 can't
// bucket skips it, so the result is r2's.
const flag: FlagDto = {
  key: 'f',
  version: 1,
  type: 'String',
  enabled: true,
  variations: [
    { key: 'on', value: 'on' },
    { key: 'fb', value: 'fb' },
  ],
  rules: [
    {
      id: 'r1',
      priority: 1,
      conditionGroups: [],
      serve: { type: 'Rollout', bucketBy: 'groups', salt: 's', variations: [{ key: 'on', weight: 100 }] },
    },
    { id: 'r2', priority: 2, conditionGroups: [], serve: { type: 'Fixed', variation: 'fb' } },
  ],
  fallthrough: { type: 'Fixed', variation: 'fb' },
  offVariation: 'fb',
};

const ruleFor = (groups: unknown) => evaluate(flag, { user_id: 'u1', groups }, { md5 }).ruleId;

// Arrays and plain objects are pinned by the f-unbucketable-custom-* golden vectors;
// these are the JS-only shapes no JSON vector can carry (#4572).
describe('non-scalar bucket values (#4572)', () => {
  it.each([
    ['Map', new Map([['id', 'acme']])],
    ['Set', new Set(['a'])],
    ['null-prototype object', Object.assign(Object.create(null), { id: 'acme' })],
  ])('a %s cannot be bucketed', (_name, value) => {
    expect(ruleFor(value)).toBe('r2');
  });

  it('a Date or a class with its own toString still buckets', () => {
    class Id {
      toString() {
        return 'acme';
      }
    }
    expect(ruleFor(new Date(0))).toBe('r1');
    expect(ruleFor(new Id())).toBe('r1');
  });
});
