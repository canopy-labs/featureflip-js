import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { warnUnbucketable, __resetUnbucketableForTests } from '../src/core/unbucketable.js';
import { resolveDetail } from '../src/core/resolve-detail.js';
import type { FlagDto } from '../src/core/types.js';

beforeEach(() => __resetUnbucketableForTests());
afterEach(() => __resetUnbucketableForTests());

const md5 = (input: string) => createHash('md5').update(input, 'utf8').digest();

function flagWith(key: string, enabled = true): FlagDto {
  return {
    key,
    version: 1,
    type: 'Boolean',
    enabled,
    variations: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    rules: [
      {
        id: 'r1',
        priority: 1,
        conditionGroups: [],
        serve: {
          type: 'Rollout',
          bucketBy: 'userId',
          salt: 's',
          variations: [
            { key: 'on', weight: 1 },
            { key: 'off', weight: 99 },
          ],
        },
      },
    ],
    fallthrough: { type: 'Fixed', variation: 'off' },
    offVariation: 'off',
  };
}

function evalKeyless(flag: FlagDto, sink: (m: string) => void, ctx = {}) {
  resolveDetail(flag, ctx, false, {
    md5,
    getSegment: () => undefined,
    onUnbucketable: (i) => warnUnbucketable(i, sink),
  }, { [flag.key]: flag });
}

describe('unbucketable warning (#4236)', () => {
  it('warns once per flag and rule, naming ids but never context values', () => {
    const msgs: string[] = [];
    const flag = flagWith('warn-once-flag');
    evalKeyless(flag, (m) => msgs.push(m), { email: 'secret@example.com' });
    evalKeyless(flag, (m) => msgs.push(m), { email: 'secret@example.com' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toBe(
      '[featureflip] Skipped the percentage rollout in flag "warn-once-flag" (rule r1): the context has no value for "userId". Pass a stable id in that attribute to include this context in the rollout.',
    );
    expect(msgs[0]).not.toContain('secret@example.com');
  });

  it('does not warn for a disabled flag', () => {
    const msgs: string[] = [];
    evalKeyless(flagWith('warn-disabled-flag', false), (m) => msgs.push(m));
    expect(msgs).toHaveLength(0);
  });

  it('is silent when no hook is wired', () => {
    const flag = flagWith('no-hook-flag');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveDetail(flag, {}, false, { md5, getSegment: () => undefined }, { [flag.key]: flag });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('caps the dedup set at 1000 keys and drops later keys silently', () => {
    const msgs: string[] = [];
    for (let i = 0; i < 1100; i++) {
      warnUnbucketable({ flagKey: `cap-flag-${i}`, ruleId: null, bucketBy: 'userId' }, (m) => msgs.push(m));
    }
    expect(msgs.length).toBeLessThanOrEqual(1000);
    const before = msgs.length;
    warnUnbucketable({ flagKey: 'cap-flag-brand-new', ruleId: null, bucketBy: 'userId' }, (m) => msgs.push(m));
    expect(msgs).toHaveLength(before);
  });
});
