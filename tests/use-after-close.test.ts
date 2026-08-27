import { describe, it, expect } from 'vitest';
import { FeatureflipClient } from '../src/client.js';

// A closed handle must return the caller's default from every accessor and
// report isInitialized === false (#2310).
//
// close() releases the core, which shuts down SSE, clears timers and flushes
// events — but the in-memory store stays readable. Without a guard the handle
// keeps serving a frozen snapshot that can never update again, while still
// reporting itself initialized. The `disposed` field already existed but was
// only ever read to make close() idempotent. Python and PHP already implement
// and document the guarded behaviour.

function makeClient() {
  return FeatureflipClient.forTesting({
    'bool-flag': true,
    'string-flag': 'hello',
    'number-flag': 42,
  });
}

describe('use after close', () => {
  it('returns the caller default from every accessor', async () => {
    const client = makeClient();

    // Precondition: the fixture really serves non-default values while open, so
    // a pass below cannot come from an empty store.
    expect(client.boolVariation('bool-flag', {}, false)).toBe(true);

    await client.close();

    expect(client.boolVariation('bool-flag', {}, false)).toBe(false);
    expect(client.stringVariation('string-flag', {}, 'DEF')).toBe('DEF');
    expect(client.numberVariation('number-flag', {}, -1)).toBe(-1);
    expect(client.jsonVariation('bool-flag', {}, { a: 1 })).toEqual({ a: 1 });
  });

  it('reports isInitialized false', async () => {
    const client = makeClient();
    expect(client.isInitialized).toBe(true);

    await client.close();

    expect(client.isInitialized).toBe(false);
  });

  it('variationDetail returns the default with an Error reason', async () => {
    const client = makeClient();
    await client.close();

    const detail = client.variationDetail('bool-flag', {}, false);
    expect(detail.value).toBe(false);
    expect(detail.reason).toBe('Error');
  });

  it('close stays idempotent', async () => {
    const client = makeClient();
    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('leaves an open client completely unaffected', async () => {
    const client = makeClient();
    try {
      expect(client.boolVariation('bool-flag', {}, false)).toBe(true);
      expect(client.stringVariation('string-flag', {}, 'DEF')).toBe('hello');
      expect(client.isInitialized).toBe(true);
    } finally {
      await client.close();
    }
  });
});
