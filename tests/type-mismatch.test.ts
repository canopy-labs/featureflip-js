import { describe, it, expect, vi, afterEach } from 'vitest';
import { FeatureflipClient } from '../src/client.js';
import type { Platform } from '../src/platform/types.js';
import type {
  GetFlagsResponse,
  FlagDto,
  EvaluationInspector,
} from '../src/core/types.js';
import { createHash } from 'crypto';

// A typed accessor whose served value is not of the requested type must hand back
// the caller's default and report 'Error', so the mismatch is detectable (#2281).
// TypeScript's types are erased at runtime, so boolVariation<boolean> happily
// returned whatever the flag served — a string where the caller's code expected a
// boolean.

function md5(input: string): Uint8Array {
  return createHash('md5').update(input, 'utf8').digest();
}

function makeResponse(): GetFlagsResponse {
  const flags: FlagDto[] = [
    {
      key: 'bool-flag',
      version: 1,
      type: 'Boolean',
      enabled: true,
      variations: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      rules: [],
      fallthrough: { type: 'Fixed', variation: 'off' },
      offVariation: 'off',
    },
    {
      key: 'str-flag',
      version: 1,
      type: 'String',
      enabled: true,
      variations: [{ key: 'v', value: '42' }],
      rules: [],
      fallthrough: { type: 'Fixed', variation: 'v' },
      offVariation: 'v',
    },
    {
      key: 'num-flag',
      version: 1,
      type: 'Number',
      enabled: true,
      variations: [{ key: 'v', value: 42 }],
      rules: [],
      fallthrough: { type: 'Fixed', variation: 'v' },
      offVariation: 'v',
    },
  ];
  return { flags, segments: [] } as unknown as GetFlagsResponse;
}

function makePlatform(): Platform {
  return {
    md5,
    createEventSource: () => ({
      addEventListener: () => {},
      close: () => {},
      readyState: 2,
    }),
    fetch: async () =>
      ({ ok: true, json: async () => makeResponse() }) as unknown as Response,
  } as unknown as Platform;
}

async function makeClient(inspectors: unknown[] = []) {
  const client = FeatureflipClient.get(
    {
      sdkKey: 'type-mismatch-key',
      baseUrl: 'http://localhost:5000',
      streaming: false,
      inspectors: inspectors as EvaluationInspector[],
    },
    makePlatform(),
  );
  await client.waitForInitialization();
  return client;
}

describe('type-mismatched reads', () => {
  afterEach(async () => {
    await FeatureflipClient.resetForTesting();
  });

  describe("returns the caller's default instead of the served value", () => {
    it('bool flag read as a string', async () => {
      const client = await makeClient();
      expect(client.stringVariation('bool-flag', {}, 'DEF')).toBe('DEF');
    });

    it('bool flag read as a number', async () => {
      const client = await makeClient();
      expect(client.numberVariation('bool-flag', {}, -1)).toBe(-1);
    });

    it('string flag read as a number', async () => {
      const client = await makeClient();
      expect(client.numberVariation('str-flag', {}, -1)).toBe(-1);
    });

    it('string flag read as a bool', async () => {
      const client = await makeClient();
      expect(client.boolVariation('str-flag', {}, true)).toBe(true);
    });

    it('number flag read as a string', async () => {
      const client = await makeClient();
      expect(client.stringVariation('num-flag', {}, 'DEF')).toBe('DEF');
    });

    it('number flag read as a bool', async () => {
      const client = await makeClient();
      expect(client.boolVariation('num-flag', {}, true)).toBe(true);
    });
  });

  describe('reports the mismatch to inspectors', () => {
    it("reports Error with the caller's default as the value", async () => {
      const spy = vi.fn();
      const client = await makeClient([spy]);

      client.numberVariation('bool-flag', { userId: 'bob' }, -1);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ reason: 'Error', value: -1 });
    });

    it('leaves a matching read reporting its real reason', async () => {
      const spy = vi.fn();
      const client = await makeClient([spy]);

      expect(client.boolVariation('bool-flag', { userId: 'bob' }, true)).toBe(false);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({
        reason: 'Fallthrough',
        value: false,
      });
    });
  });

  describe('matching reads are unaffected', () => {
    it('serves each flag through its own accessor', async () => {
      const client = await makeClient();
      expect(client.boolVariation('bool-flag', {}, true)).toBe(false);
      expect(client.stringVariation('str-flag', {}, 'DEF')).toBe('42');
      expect(client.numberVariation('num-flag', {}, -1)).toBe(42);
    });

    it('leaves the generic variationDetail unchecked', async () => {
      // variationDetail takes no requested type at runtime, so there is nothing
      // to mismatch against — it keeps returning the served value and its reason.
      const client = await makeClient();
      const detail = client.variationDetail('str-flag', {}, 'DEF');
      expect(detail.value).toBe('42');
      expect(detail.reason).toBe('Fallthrough');
    });

    it('leaves jsonVariation unchecked', async () => {
      const client = await makeClient();
      expect(client.jsonVariation('str-flag', {}, { a: 1 })).toBe('42');
    });
  });
});
