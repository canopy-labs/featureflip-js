import { describe, it, expect, vi } from 'vitest';
import { FlagStore } from '../src/core/store.js';
import type { FlagDto, SegmentDto } from '../src/core/types.js';

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

function makeSegment(overrides: Partial<SegmentDto> = {}): SegmentDto {
  return {
    key: 'test-segment',
    version: 1,
    conditions: [],
    conditionLogic: 'And',
    ...overrides,
  };
}

describe('FlagStore', () => {
  it('starts empty', () => {
    const store = new FlagStore();
    expect(store.getFlag('any')).toBeUndefined();
    expect(store.getAllFlags()).toEqual([]);
    expect(store.getVersion()).toBe(0);
  });

  describe('init', () => {
    it('loads flags and segments', () => {
      const store = new FlagStore();
      const flag = makeFlag();
      const segment = makeSegment();

      store.init([flag], [segment], 5);

      expect(store.getFlag('test-flag')).toEqual(flag);
      expect(store.getSegment('test-segment')).toEqual(segment);
      expect(store.getVersion()).toBe(5);
      expect(store.getAllFlags()).toHaveLength(1);
    });

    it('replaces existing data', () => {
      const store = new FlagStore();
      store.init([makeFlag()], [], 1);
      store.init([makeFlag({ key: 'new-flag' })], [], 2);

      expect(store.getFlag('test-flag')).toBeUndefined();
      expect(store.getFlag('new-flag')).toBeDefined();
      expect(store.getVersion()).toBe(2);
    });

    it('notifies listeners for all flags after init', () => {
      const store = new FlagStore();
      const listener = vi.fn();
      store.onChange(listener);

      store.init(
        [makeFlag({ key: 'flag-a' }), makeFlag({ key: 'flag-b' })],
        [makeSegment()],
        1,
      );

      expect(listener).toHaveBeenCalledWith('flag-a');
      expect(listener).toHaveBeenCalledWith('flag-b');
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  describe('upsert', () => {
    it('adds new flag', () => {
      const store = new FlagStore();
      store.upsert(makeFlag());
      expect(store.getFlag('test-flag')).toBeDefined();
    });

    it('updates flag with higher version', () => {
      const store = new FlagStore();
      store.upsert(makeFlag({ version: 1 }));
      store.upsert(makeFlag({ version: 2, enabled: false }));
      expect(store.getFlag('test-flag')!.enabled).toBe(false);
    });

    it('ignores flag with same or lower version', () => {
      const store = new FlagStore();
      store.upsert(makeFlag({ version: 3, enabled: true }));
      store.upsert(makeFlag({ version: 2, enabled: false }));
      expect(store.getFlag('test-flag')!.enabled).toBe(true);

      store.upsert(makeFlag({ version: 3, enabled: false }));
      expect(store.getFlag('test-flag')!.enabled).toBe(true);
    });
  });

  describe('delete', () => {
    it('removes a flag', () => {
      const store = new FlagStore();
      store.upsert(makeFlag());
      store.delete('test-flag');
      expect(store.getFlag('test-flag')).toBeUndefined();
    });

    it('no-ops for unknown flag', () => {
      const store = new FlagStore();
      store.delete('nonexistent');
      // No error
    });
  });

  describe('onChange', () => {
    it('notifies listeners on upsert', () => {
      const store = new FlagStore();
      const listener = vi.fn();
      store.onChange(listener);

      store.upsert(makeFlag());
      expect(listener).toHaveBeenCalledWith('test-flag');
    });

    it('notifies listeners on delete', () => {
      const store = new FlagStore();
      store.upsert(makeFlag());

      const listener = vi.fn();
      store.onChange(listener);
      store.delete('test-flag');
      expect(listener).toHaveBeenCalledWith('test-flag');
    });

    it('does not notify on no-op delete', () => {
      const store = new FlagStore();
      const listener = vi.fn();
      store.onChange(listener);
      store.delete('nonexistent');
      expect(listener).not.toHaveBeenCalled();
    });

    it('allows unsubscribing', () => {
      const store = new FlagStore();
      const listener = vi.fn();
      const unsub = store.onChange(listener);

      unsub();
      store.upsert(makeFlag());
      expect(listener).not.toHaveBeenCalled();
    });

    it('swallows listener errors', () => {
      const store = new FlagStore();
      const badListener = vi.fn(() => {
        throw new Error('boom');
      });
      const goodListener = vi.fn();

      store.onChange(badListener);
      store.onChange(goodListener);

      store.upsert(makeFlag());
      expect(badListener).toHaveBeenCalled();
      expect(goodListener).toHaveBeenCalled();
    });
  });
});
