import { describe, it, expect, vi, afterEach } from 'vitest';
import { FeatureflipClient } from '../src/client.js';
import type { Platform } from '../src/platform/types.js';
import type {
  GetFlagsResponse,
  FlagDto,
  EvaluationEvent,
  EvaluationInspector,
} from '../src/core/types.js';
import { createHash } from 'crypto';

function md5(input: string): Uint8Array {
  return createHash('md5').update(input, 'utf8').digest();
}

function makeResponse(): GetFlagsResponse {
  const flags: FlagDto[] = [
    {
      key: 'flag-on',
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
    },
    {
      key: 'flag-off',
      version: 1,
      type: 'Boolean',
      enabled: false,
      variations: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      rules: [],
      fallthrough: { type: 'Fixed', variation: 'on' },
      offVariation: 'off',
    },
    {
      key: 'flag-rule',
      version: 1,
      type: 'Boolean',
      enabled: true,
      variations: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      rules: [
        {
          id: 'rule-1',
          priority: 1,
          conditionGroups: [
            {
              operator: 'And',
              conditions: [
                { attribute: 'userId', operator: 'Equals', values: ['alice'], negate: false },
              ],
            },
          ],
          serve: { type: 'Fixed', variation: 'on' },
        },
      ],
      fallthrough: { type: 'Fixed', variation: 'off' },
      offVariation: 'off',
    },
    {
      key: 'flag-prereq',
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
      prerequisites: [
        { prerequisiteFlagKey: 'flag-off', expectedVariationKey: 'on' },
      ],
    },
    // Malformed on purpose: `variations` is undefined, so the evaluator throws
    // at fallthrough resolution → the core's catch → reason 'Error'.
    {
      key: 'flag-error',
      version: 1,
      type: 'Boolean',
      enabled: true,
      variations: undefined,
      rules: [],
      fallthrough: { type: 'Fixed', variation: 'x' },
      offVariation: 'x',
    } as unknown as FlagDto,
    // Malformed on purpose: the fallthrough serves a variation key the flag
    // does not define (e.g. a since-deleted variation). The evaluator returns
    // that key with a null value; the core degrades to the caller's default and
    // reports 'Error' — mirroring the engine + the C#/Java SDKs (#1989).
    {
      key: 'flag-missing-variation',
      version: 1,
      type: 'Boolean',
      enabled: true,
      variations: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      rules: [],
      fallthrough: { type: 'Fixed', variation: 'ghost' },
      offVariation: 'off',
    },
  ];
  return { environment: 'test', version: 1, flags, segments: [] };
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
  };
}

async function makeClient(inspectors: unknown[]) {
  const client = FeatureflipClient.get(
    {
      sdkKey: 'insp-key',
      baseUrl: 'http://localhost:5000',
      streaming: false,
      inspectors: inspectors as EvaluationInspector[],
    },
    makePlatform(),
  );
  await client.waitForInitialization();
  return client;
}

describe('evaluation inspectors', () => {
  afterEach(async () => {
    await FeatureflipClient.resetForTesting();
  });

  it('fires once per call with full payload on the fallthrough path', async () => {
    const spy = vi.fn();
    const client = await makeClient([spy]);

    const ctx = { user_id: 'bob', plan: 'pro' };
    expect(client.boolVariation('flag-on', ctx, false)).toBe(true);

    expect(spy).toHaveBeenCalledTimes(1);
    const e = spy.mock.calls[0][0] as EvaluationEvent;
    expect(e.flagKey).toBe('flag-on');
    expect(e.value).toBe(true);
    expect(e.variationKey).toBe('on');
    expect(e.reason).toBe('Fallthrough');
    expect(e.ruleId).toBeUndefined();
    expect(e.prerequisiteKey).toBeUndefined();
    expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(e.context).toEqual(ctx);
    expect(e.context).not.toBe(ctx); // shallow copy, not the caller's object

    await client.close();
  });

  it('reports ruleId on a rule match', async () => {
    const spy = vi.fn();
    const client = await makeClient([spy]);

    expect(client.boolVariation('flag-rule', { user_id: 'alice' }, false)).toBe(true);

    const e = spy.mock.calls[0][0] as EvaluationEvent;
    expect(e.reason).toBe('RuleMatch');
    expect(e.ruleId).toBe('rule-1');
    expect(e.variationKey).toBe('on');

    await client.close();
  });

  it('reports FlagDisabled with the off value', async () => {
    const spy = vi.fn();
    const client = await makeClient([spy]);

    expect(client.boolVariation('flag-off', { user_id: 'bob' }, true)).toBe(false);

    const e = spy.mock.calls[0][0] as EvaluationEvent;
    expect(e.reason).toBe('FlagDisabled');
    expect(e.value).toBe(false);
    expect(e.variationKey).toBe('off');

    await client.close();
  });

  it('reports FlagNotFound with the default value and no variationKey', async () => {
    const spy = vi.fn();
    const client = await makeClient([spy]);

    expect(client.boolVariation('missing', { user_id: 'bob' }, true)).toBe(true);

    const e = spy.mock.calls[0][0] as EvaluationEvent;
    expect(e.flagKey).toBe('missing');
    expect(e.reason).toBe('FlagNotFound');
    expect(e.value).toBe(true);
    expect(e.variationKey).toBeUndefined();

    await client.close();
  });

  it('reports PrerequisiteFailed with prerequisiteKey', async () => {
    const spy = vi.fn();
    const client = await makeClient([spy]);

    expect(client.boolVariation('flag-prereq', { user_id: 'bob' }, false)).toBe(false);

    const e = spy.mock.calls[0][0] as EvaluationEvent;
    expect(e.reason).toBe('PrerequisiteFailed');
    expect(e.prerequisiteKey).toBe('flag-off');
    expect(e.value).toBe(false);

    await client.close();
  });

  it('reports Error and still returns the default when evaluation throws', async () => {
    const spy = vi.fn();
    const client = await makeClient([spy]);

    expect(client.boolVariation('flag-error', { user_id: 'bob' }, true)).toBe(true);

    const e = spy.mock.calls[0][0] as EvaluationEvent;
    expect(e.reason).toBe('Error');
    expect(e.value).toBe(true);

    await client.close();
  });

  it('reports Error when the served variation key is not defined on the flag', async () => {
    const spy = vi.fn();
    const client = await makeClient([spy]);

    // The returned detail (what the caller sees) degrades to the default and
    // reports Error — not the misleading 'Fallthrough' the evaluator resolved.
    const detail = client.variationDetail('flag-missing-variation', { user_id: 'bob' }, false);
    expect(detail.reason).toBe('Error');
    expect(detail.value).toBe(false);
    expect(detail.variationKey).toBe('ghost'); // kept for diagnostics

    // The inspector sees the same Error reason rather than a healthy exposure.
    const e = spy.mock.calls[0][0] as EvaluationEvent;
    expect(e.reason).toBe('Error');
    expect(e.value).toBe(false);

    await client.close();
  });

  it('invokes every registered inspector', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const client = await makeClient([a, b]);

    client.boolVariation('flag-on', { user_id: 'bob' }, false);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    await client.close();
  });

  it('isolates a throwing inspector: value is correct, siblings still fire, warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = vi.fn(() => {
      throw new Error('inspector boom');
    });
    const after = vi.fn();
    const client = await makeClient([boom, after]);

    expect(client.boolVariation('flag-on', { user_id: 'bob' }, false)).toBe(true);
    expect(after).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[featureflip] evaluation inspector threw:',
      expect.any(Error),
    );

    warn.mockRestore();
    await client.close();
  });

  it('ignores non-function entries without throwing', async () => {
    const spy = vi.fn();
    const client = await makeClient([null, 'nope', undefined, spy]);

    expect(client.boolVariation('flag-on', { user_id: 'bob' }, false)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    await client.close();
  });

  it('is a no-op when no inspectors are configured', async () => {
    const client = await makeClient([]);
    expect(client.boolVariation('flag-on', { user_id: 'bob' }, false)).toBe(true);
    await client.close();
  });
});
