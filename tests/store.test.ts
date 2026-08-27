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

    it('does not notify listeners on the first init', () => {
      const store = new FlagStore();
      const listener = vi.fn();
      store.onChange(listener);

      store.init(
        [makeFlag({ key: 'flag-a' }), makeFlag({ key: 'flag-b' })],
        [makeSegment()],
        1,
      );

      // Cold load is not a change — the whole snapshot arriving for the first
      // time would otherwise report every flag as "updated" on every startup.
      expect(listener).not.toHaveBeenCalled();
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

    it('ignores flag with a lower version', () => {
      const store = new FlagStore();
      store.upsert(makeFlag({ version: 3, enabled: true }));
      store.upsert(makeFlag({ version: 2, enabled: false }));
      expect(store.getFlag('test-flag')!.enabled).toBe(true);
    });

    // The wire version is second-granular (#2088), so two edits to one flag
    // inside the same wall-clock second carry an identical version. Treating
    // equal as stale discarded the second edit's config outright, and with
    // streaming on (the default) there is no polling snapshot to correct it —
    // the SDK evaluated against the pre-edit config until an SSE `sync` or
    // reconnect. Only a strictly older config is stale.
    it('applies a flag with the same version', () => {
      const store = new FlagStore();
      store.upsert(makeFlag({ version: 3, enabled: true }));
      store.upsert(makeFlag({ version: 3, enabled: false }));
      expect(store.getFlag('test-flag')!.enabled).toBe(false);
    });

    it('applies successive same-version edits, keeping the newest', () => {
      const store = new FlagStore();
      store.upsert(makeFlag({ version: 7, enabled: true }));

      store.upsert(makeFlag({ version: 7, enabled: false }));
      expect(store.getFlag('test-flag')!.enabled).toBe(false);

      store.upsert(makeFlag({ version: 7, enabled: true }));
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
      expect(listener).toHaveBeenCalledWith(['test-flag']);
    });

    it('does not notify when upsert is ignored as stale', () => {
      const store = new FlagStore();
      store.upsert(makeFlag({ version: 3 }));

      const listener = vi.fn();
      store.onChange(listener);
      store.upsert(makeFlag({ version: 2 }));
      expect(listener).not.toHaveBeenCalled();
    });

    it('notifies on a same-version upsert', () => {
      const store = new FlagStore();
      store.upsert(makeFlag({ version: 3, enabled: true }));

      const listener = vi.fn();
      store.onChange(listener);
      store.upsert(makeFlag({ version: 3, enabled: false }));
      expect(listener).toHaveBeenCalledWith(['test-flag']);
    });

    it('notifies listeners on delete', () => {
      const store = new FlagStore();
      store.upsert(makeFlag());

      const listener = vi.fn();
      store.onChange(listener);
      store.delete('test-flag');
      expect(listener).toHaveBeenCalledWith(['test-flag']);
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

  // Every poll tick and every SSE `sync` reconnect calls init() with a full
  // snapshot. Without a diff, each of those would report every flag as changed,
  // making the public update hook (and OpenFeature's
  // PROVIDER_CONFIGURATION_CHANGED) fire constantly and carry no signal.
  describe('init change detection', () => {
    function primed(flags: FlagDto[], segments: SegmentDto[] = []) {
      const store = new FlagStore();
      store.init(flags, segments, 1);
      const listener = vi.fn();
      store.onChange(listener);
      return { store, listener };
    }

    it('notifies nothing when a later snapshot is identical', () => {
      const { store, listener } = primed([
        makeFlag({ key: 'flag-a' }),
        makeFlag({ key: 'flag-b' }),
      ]);

      store.init([makeFlag({ key: 'flag-a' }), makeFlag({ key: 'flag-b' })], [], 2);

      expect(listener).not.toHaveBeenCalled();
    });

    it('notifies only the flags whose config changed', () => {
      const { store, listener } = primed([
        makeFlag({ key: 'flag-a', version: 1 }),
        makeFlag({ key: 'flag-b', version: 1 }),
      ]);

      store.init(
        [makeFlag({ key: 'flag-a', version: 2 }), makeFlag({ key: 'flag-b', version: 1 })],
        [],
        2,
      );

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(['flag-a']);
    });

    // The wire version is second-granular (eval-api divides its internal epoch-ms
    // version by 1000 to keep the public contract 32-bit safe), so two edits to
    // one flag inside the same wall-clock second carry an identical version. On a
    // full snapshot there is no per-edit signal to fall back on: if a snapshot
    // boundary lands between the two edits, a version-only diff reports nothing
    // while the store quietly takes the newer config (#2088).
    it('notifies a flag whose config changed under an unchanged version', () => {
      const { store, listener } = primed([makeFlag({ key: 'gate', version: 7 })]);

      store.init([makeFlag({ key: 'gate', version: 7, enabled: false })], [], 2);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(['gate']);
    });

    it('notifies flags referencing a segment whose config changed under an unchanged version', () => {
      const segmented = makeFlag({
        key: 'segmented',
        rules: [
          {
            id: 'r1',
            priority: 0,
            conditionGroups: [],
            serve: { type: 'Fixed', variation: 'on' },
            segmentKey: 'test-segment',
          },
        ],
      });
      const { store, listener } = primed([segmented], [makeSegment({ version: 3 })]);

      store.init([segmented], [makeSegment({ version: 3, conditionLogic: 'Or' })], 2);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(['segmented']);
    });

    it('notifies added and removed flags', () => {
      const { store, listener } = primed([makeFlag({ key: 'gone' })]);

      store.init([makeFlag({ key: 'added' })], [], 2);

      expect(listener).toHaveBeenCalledTimes(1);
      const [keys] = listener.mock.calls[0] as [string[]];
      expect([...keys].sort()).toEqual(['added', 'gone']);
    });

    it('batches every change in one snapshot into a single call', () => {
      const { store, listener } = primed([
        makeFlag({ key: 'flag-a', version: 1 }),
        makeFlag({ key: 'flag-b', version: 1 }),
      ]);

      store.init(
        [makeFlag({ key: 'flag-a', version: 2 }), makeFlag({ key: 'flag-b', version: 2 })],
        [],
        2,
      );

      expect(listener).toHaveBeenCalledTimes(1);
      const [keys] = listener.mock.calls[0] as [string[]];
      expect([...keys].sort()).toEqual(['flag-a', 'flag-b']);
    });

    // A segment edit changes evaluation outcomes without bumping any flag's
    // version, so the diff has to map changed segments onto the flags that
    // reference them — otherwise an SSE `segment.updated` is silent.
    it('notifies flags whose rules reference a changed segment', () => {
      const segmented = makeFlag({
        key: 'segmented',
        rules: [
          {
            id: 'r1',
            priority: 0,
            conditionGroups: [],
            serve: { type: 'Fixed', variation: 'on' },
            segmentKey: 'test-segment',
          },
        ],
      });
      const { store, listener } = primed(
        [segmented, makeFlag({ key: 'unrelated' })],
        [makeSegment({ version: 1 })],
      );

      store.init([segmented, makeFlag({ key: 'unrelated' })], [makeSegment({ version: 2 })], 2);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(['segmented']);
    });

    it('notifies flags referencing an added or removed segment', () => {
      const segmented = makeFlag({
        key: 'segmented',
        rules: [
          {
            id: 'r1',
            priority: 0,
            conditionGroups: [],
            serve: { type: 'Fixed', variation: 'on' },
            segmentKey: 'test-segment',
          },
        ],
      });
      const { store, listener } = primed([segmented], [makeSegment()]);

      store.init([segmented], [], 2);

      expect(listener).toHaveBeenCalledWith(['segmented']);
    });

    it('does not notify when an unreferenced segment changes', () => {
      const { store, listener } = primed(
        [makeFlag({ key: 'unrelated' })],
        [makeSegment({ version: 1 })],
      );

      store.init([makeFlag({ key: 'unrelated' })], [makeSegment({ version: 2 })], 2);

      expect(listener).not.toHaveBeenCalled();
    });

    it('reports a flag once when both it and its segment changed', () => {
      const rules = [
        {
          id: 'r1',
          priority: 0,
          conditionGroups: [],
          serve: { type: 'Fixed' as const, variation: 'on' },
          segmentKey: 'test-segment',
        },
      ];
      const { store, listener } = primed(
        [makeFlag({ key: 'segmented', version: 1, rules })],
        [makeSegment({ version: 1 })],
      );

      store.init(
        [makeFlag({ key: 'segmented', version: 2, rules })],
        [makeSegment({ version: 2 })],
        2,
      );

      expect(listener).toHaveBeenCalledWith(['segmented']);
    });

    // A flag's version covers its own prerequisite rows, but not the flags those
    // rows point at. Toggling a prerequisite `P` bumps only `P`'s version, while
    // the evaluator resolves prerequisites recursively — so a dependent `C` flips
    // to its off variation with no version change of its own. Without this
    // fan-out, `C`'s value changes and `C` is never reported.
    describe('prerequisite fan-out', () => {
      function dependingOn(key: string, prerequisiteFlagKey: string, version = 1): FlagDto {
        return makeFlag({
          key,
          version,
          prerequisites: [{ prerequisiteFlagKey, expectedVariationKey: 'on' }],
        });
      }

      it('notifies a flag whose prerequisite changed', () => {
        const { store, listener } = primed([
          makeFlag({ key: 'parent', version: 1 }),
          dependingOn('child', 'parent'),
        ]);

        store.init(
          [makeFlag({ key: 'parent', version: 2 }), dependingOn('child', 'parent')],
          [],
          2,
        );

        expect(listener).toHaveBeenCalledTimes(1);
        const [keys] = listener.mock.calls[0] as [string[]];
        expect([...keys].sort()).toEqual(['child', 'parent']);
      });

      it('notifies transitively down a prerequisite chain', () => {
        const { store, listener } = primed([
          makeFlag({ key: 'root', version: 1 }),
          dependingOn('mid', 'root'),
          dependingOn('leaf', 'mid'),
        ]);

        store.init(
          [
            makeFlag({ key: 'root', version: 2 }),
            dependingOn('mid', 'root'),
            dependingOn('leaf', 'mid'),
          ],
          [],
          2,
        );

        const [keys] = listener.mock.calls[0] as [string[]];
        expect([...keys].sort()).toEqual(['leaf', 'mid', 'root']);
      });

      it('notifies a flag whose prerequisite was removed', () => {
        const { store, listener } = primed([
          makeFlag({ key: 'parent' }),
          dependingOn('child', 'parent'),
        ]);

        store.init([dependingOn('child', 'parent')], [], 2);

        const [keys] = listener.mock.calls[0] as [string[]];
        expect([...keys].sort()).toEqual(['child', 'parent']);
      });

      // Ordering guard: the prerequisite walk has to be seeded with the *fully*
      // resolved changed set, segment fan-out included. Running it first would
      // miss dependents of a flag that only a segment edit pulled in.
      it('notifies dependents of a flag pulled in by a segment change', () => {
        const segmented = makeFlag({
          key: 'segmented',
          rules: [
            {
              id: 'r1',
              priority: 0,
              conditionGroups: [],
              serve: { type: 'Fixed', variation: 'on' },
              segmentKey: 'test-segment',
            },
          ],
        });
        const { store, listener } = primed(
          [segmented, dependingOn('child', 'segmented')],
          [makeSegment({ version: 1 })],
        );

        store.init(
          [segmented, dependingOn('child', 'segmented')],
          [makeSegment({ version: 2 })],
          2,
        );

        const [keys] = listener.mock.calls[0] as [string[]];
        expect([...keys].sort()).toEqual(['child', 'segmented']);
      });

      // The server rejects prerequisite cycles, so this only guards against a
      // malformed payload — but an unbounded walk would hang the poll thread.
      it('terminates on a prerequisite cycle', () => {
        const { store, listener } = primed([
          dependingOn('a', 'b', 1),
          dependingOn('b', 'a', 1),
        ]);

        store.init([dependingOn('a', 'b', 2), dependingOn('b', 'a', 1)], [], 2);

        const [keys] = listener.mock.calls[0] as [string[]];
        expect([...keys].sort()).toEqual(['a', 'b']);
      });

      it('reports a flag once when both it and its prerequisite changed', () => {
        const { store, listener } = primed([
          makeFlag({ key: 'parent', version: 1 }),
          dependingOn('child', 'parent', 1),
        ]);

        store.init(
          [makeFlag({ key: 'parent', version: 2 }), dependingOn('child', 'parent', 2)],
          [],
          2,
        );

        expect(listener).toHaveBeenCalledTimes(1);
        const [keys] = listener.mock.calls[0] as [string[]];
        expect([...keys].sort()).toEqual(['child', 'parent']);
      });

      // SSE is the default real-time path: `flag.updated` refetches the one flag
      // and calls upsert(), `flag.deleted` calls delete(). Both name a single key,
      // so without fan-out a prerequisite toggled over SSE never reaches its
      // dependents — the same defect as the snapshot diff, different entry point.
      it('notifies dependents when a prerequisite is upserted', () => {
        const store = new FlagStore();
        store.init(
          [makeFlag({ key: 'parent', version: 1 }), dependingOn('child', 'parent')],
          [],
          1,
        );
        const listener = vi.fn();
        store.onChange(listener);

        store.upsert(makeFlag({ key: 'parent', version: 2 }));

        const [keys] = listener.mock.calls[0] as [string[]];
        expect([...keys].sort()).toEqual(['child', 'parent']);
      });

      it('notifies dependents when a prerequisite is deleted', () => {
        const store = new FlagStore();
        store.init(
          [makeFlag({ key: 'parent' }), dependingOn('child', 'parent')],
          [],
          1,
        );
        const listener = vi.fn();
        store.onChange(listener);

        store.delete('parent');

        const [keys] = listener.mock.calls[0] as [string[]];
        expect([...keys].sort()).toEqual(['child', 'parent']);
      });

      it('notifies transitively when a prerequisite is upserted', () => {
        const store = new FlagStore();
        store.init(
          [
            makeFlag({ key: 'root', version: 1 }),
            dependingOn('mid', 'root'),
            dependingOn('leaf', 'mid'),
          ],
          [],
          1,
        );
        const listener = vi.fn();
        store.onChange(listener);

        store.upsert(makeFlag({ key: 'root', version: 2 }));

        const [keys] = listener.mock.calls[0] as [string[]];
        expect([...keys].sort()).toEqual(['leaf', 'mid', 'root']);
      });

      it('still reports only the key itself when nothing depends on it', () => {
        const store = new FlagStore();
        store.init([makeFlag({ key: 'lonely', version: 1 })], [], 1);
        const listener = vi.fn();
        store.onChange(listener);

        store.upsert(makeFlag({ key: 'lonely', version: 2 }));

        expect(listener).toHaveBeenCalledWith(['lonely']);
      });

      it('does not notify a dependent when its prerequisite is unchanged', () => {
        const { store, listener } = primed([
          makeFlag({ key: 'parent', version: 1 }),
          dependingOn('child', 'parent'),
          makeFlag({ key: 'unrelated', version: 1 }),
        ]);

        store.init(
          [
            makeFlag({ key: 'parent', version: 1 }),
            dependingOn('child', 'parent'),
            makeFlag({ key: 'unrelated', version: 2 }),
          ],
          [],
          2,
        );

        expect(listener).toHaveBeenCalledWith(['unrelated']);
      });
    });
  });
});
