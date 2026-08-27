import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { FlagStore } from '../src/core/store';
import { MalformedPayloadError, validateSnapshot } from '../src/core/validate-snapshot';
import { dropUnevaluableEntities } from '../src/core/unevaluable';
import type { GetFlagsResponse } from '../src/core/types';

/**
 * Runner for the shared `malformedConfigVectors` class (#2315).
 *
 * The rule: a config payload violating the wire contract is discarded WHOLESALE,
 * never partially applied. js is one of the two SDKs that used to fail this silently
 * — an integer `conditionLogic` was stored verbatim, then failed the `=== 'And'`
 * check and flipped a segment from matching ALL of its conditions to ANY (#2279).
 *
 * `malformed-payload.test.ts` covers that per-SDK. This runner covers the same ground
 * from the SHARED fixture, so a divergence between SDKs fails a build.
 *
 * The two steps below are exactly what SharedFeatureflipCore does at every parse
 * boundary — validate, then apply — so the runner exercises the real sequence rather
 * than a paraphrase of it.
 */
interface MalformedVector {
  id: string;
  description: string;
  kind: string;
  expect: 'reject' | 'accept' | 'dropEntity';
  /** dropEntity only — the entities the payload must LOSE, and the ones it must keep. */
  dropFlags?: string[];
  dropSegments?: string[];
  keepFlags?: string[];
  keepSegments?: string[];
  payload: GetFlagsResponse;
}

const { seed, vectors } = (
  JSON.parse(readFileSync(new URL('./golden/vectors.json', import.meta.url), 'utf8')) as {
    malformedConfigVectors: { seed: GetFlagsResponse; vectors: MalformedVector[] };
  }
).malformedConfigVectors;

/** Applies the shared seed. A runner whose seed silently failed would "pass" every
 *  reject vector for the wrong reason, so this throws rather than returning a flag. */
function seeded(): FlagStore {
  const store = new FlagStore();
  validateSnapshot(seed);
  store.init(seed.flags, seed.segments, seed.version);
  if (!store.getFlag('mc-seed')) {
    throw new Error('seed snapshot did not apply — the runner would prove nothing');
  }
  return store;
}

function applySnapshot(store: FlagStore, payload: GetFlagsResponse): boolean {
  try {
    validateSnapshot(payload);
    // Mirrors SharedFeatureflipCore.applySnapshot: validate for TYPE violations, then
    // drop the entities carrying an enum NAME this build cannot evaluate (#2402). Two
    // different axes, applied in that order — a runner that skipped the second step
    // would pass every dropEntity vector by storing the flag it is supposed to drop.
    const { flags, segments } = dropUnevaluableEntities(payload);
    store.init(flags, segments, payload.version);
    return true;
  } catch (err) {
    if (err instanceof MalformedPayloadError) return false;
    throw err;
  }
}

describe('golden malformedConfigVectors', () => {
  it('has vectors to run', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(8);
  });

  let executed = 0;
  for (const v of vectors) {
    executed++;
    it(`${v.id}: ${v.description}`, () => {
      const store = seeded();

      const applied = applySnapshot(store, v.payload);

      if (v.expect === 'reject') {
        expect(applied).toBe(false);
        // Wholesale: the previous config still serves, and nothing from the
        // rejected payload leaked in.
        expect(store.getFlag('mc-seed')).toBeDefined();
        expect(store.getFlag('mc-bad-type')).toBeUndefined();
      } else if (v.expect === 'accept') {
        expect(applied).toBe(true);
        expect(
          store.getFlag('mc-accepted-flag') ?? store.getSegment('mc-accepted'),
        ).toBeDefined();
      } else if (v.expect === 'dropEntity') {
        // Neither accept nor reject: the payload APPLIES, minus the entities carrying
        // an enum this build cannot evaluate. Asserting both halves is the point —
        // "dropped" alone is satisfied by rejecting the whole payload, and "kept"
        // alone by tolerating the bad value.
        expect(applied).toBe(true);
        for (const key of v.dropFlags ?? []) {
          expect(store.getFlag(key), `flag "${key}" should have been dropped`).toBeUndefined();
        }
        for (const key of v.dropSegments ?? []) {
          expect(store.getSegment(key), `segment "${key}" should have been dropped`).toBeUndefined();
        }
        for (const key of v.keepFlags ?? []) {
          expect(store.getFlag(key), `flag "${key}" should have been kept`).toBeDefined();
        }
        for (const key of v.keepSegments ?? []) {
          expect(store.getSegment(key), `segment "${key}" should have been kept`).toBeDefined();
        }
      } else {
        throw new Error(`unmapped expect "${v.expect}"`);
      }
    });
  }

  it('executed the expected number of vectors', () => {
    expect(executed).toBeGreaterThanOrEqual(8);
  });
});
