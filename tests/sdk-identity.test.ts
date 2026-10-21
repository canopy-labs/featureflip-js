import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';
import { FeatureflipClient } from '../src/client.js';
import { createNodePlatform } from '../src/platform/node.js';
import { createBrowserPlatform } from '../src/platform/browser.js';
import type { Platform, EventSourceLike } from '../src/platform/types.js';

/**
 * Every request names the SDK and its version so the Evaluation API can count
 * usage (#4144, contract in #4138): `featureflip-js/<version>`, followed by any
 * wrapper tokens (node-sdk, an OpenFeature provider). Node carries it in
 * User-Agent; a browser cannot set User-Agent, so it goes in X-Featureflip-SDK.
 *
 * Asserted on the headers the core actually hands to fetch and to
 * createEventSource, for all three paths: the flag fetch, the event post and the
 * stream connect.
 */

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8')) as {
  version: string;
};
const SDK_TOKEN = `featureflip-js/${pkg.version}`;

const FLAGS = {
  environment: 'test',
  version: 1,
  flags: [
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
      fallthrough: { type: 'Fixed', variation: 'on' },
      offVariation: 'off',
    },
  ],
  segments: [],
};

function mockPlatform(identityHeader?: Platform['identityHeader']) {
  const es: EventSourceLike = { addEventListener: () => {}, close: () => {}, readyState: 1 };
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (url.endsWith('/v1/sdk/flags') ? FLAGS : {}),
  }));
  const createEventSourceMock = vi.fn().mockReturnValue(es);
  const platform: Platform = {
    md5: (input) => createHash('md5').update(input, 'utf8').digest(),
    fetch: fetchMock as unknown as Platform['fetch'],
    createEventSource: createEventSourceMock,
    sseSupportsHeaders: true,
    identityHeader,
  };
  return { platform, fetchMock, createEventSourceMock };
}

/** Drives one request down each path and returns the headers each carried. */
async function captureHeaders(
  platform: ReturnType<typeof mockPlatform>,
  wrappers?: string[],
): Promise<Record<'flags' | 'events' | 'stream', Record<string, string>>> {
  const client = FeatureflipClient.get(
    { sdkKey: 'test-key', baseUrl: 'http://localhost:5000', streaming: true, wrappers },
    platform.platform,
  );
  await client.waitForInitialization();
  client.boolVariation('bool-flag', { user_id: 'u' }, false);
  await client.flush();

  const headersFor = (suffix: string) => {
    const call = platform.fetchMock.mock.calls.find(([url]) => (url as string).endsWith(suffix));
    return (call?.[1] as RequestInit).headers as Record<string, string>;
  };
  const result = {
    flags: headersFor('/v1/sdk/flags'),
    events: headersFor('/v1/sdk/events'),
    stream: platform.createEventSourceMock.mock.calls[0]?.[1] as Record<string, string>,
  };
  await client.close();
  return result;
}

describe('SDK identity', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await FeatureflipClient.resetForTesting();
  });

  it('sends featureflip-js/<version> in User-Agent on every path when the platform names it', async () => {
    const headers = await captureHeaders(mockPlatform('User-Agent'));

    expect(headers.flags['User-Agent']).toBe(SDK_TOKEN);
    expect(headers.events['User-Agent']).toBe(SDK_TOKEN);
    expect(headers.stream['User-Agent']).toBe(SDK_TOKEN);
  });

  it('defaults to X-Featureflip-SDK, the header any runtime may set', async () => {
    // A custom platform that predates identityHeader (React Native, an edge
    // runtime) must still identify itself, and the custom header is the one no
    // runtime forbids.
    const headers = await captureHeaders(mockPlatform(undefined));

    expect(headers.flags['X-Featureflip-SDK']).toBe(SDK_TOKEN);
    expect(headers.events['X-Featureflip-SDK']).toBe(SDK_TOKEN);
    expect(headers.stream['X-Featureflip-SDK']).toBe(SDK_TOKEN);
  });

  it('appends wrapper tokens in order after the SDK token', async () => {
    const headers = await captureHeaders(mockPlatform('User-Agent'), [
      'featureflip-node/2.5.0',
      'featureflip-openfeature-node/1.0.0',
    ]);

    const expected = `${SDK_TOKEN} featureflip-node/2.5.0 featureflip-openfeature-node/1.0.0`;
    expect(headers.flags['User-Agent']).toBe(expected);
    expect(headers.events['User-Agent']).toBe(expected);
    expect(headers.stream['User-Agent']).toBe(expected);
  });

  it('drops an invalid wrapper token with a warning and keeps the valid ones', async () => {
    // A space is not a legal product-token character. Identity metadata must
    // never stop the client starting, so the bad token is dropped and said so.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const headers = await captureHeaders(mockPlatform('User-Agent'), ['bad token/1', 'ok-wrapper']);

    expect(headers.flags['User-Agent']).toBe(`${SDK_TOKEN} ok-wrapper`);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad token/1'));
  });

  it('does not warn about different options when only the wrappers differ', async () => {
    // Wrappers identify the caller, not behavior: a provider sharing an SDK key
    // with the host application must not trip the config-equality warning.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { platform } = mockPlatform('User-Agent');
    const config = { sdkKey: 'shared-key', baseUrl: 'http://localhost:5000', streaming: false };

    const a = FeatureflipClient.get(config, platform);
    const b = FeatureflipClient.get({ ...config, wrappers: ['some-wrapper/1.0'] }, platform);

    expect(warn).not.toHaveBeenCalled();
    await a.close();
    await b.close();
  });

  it('node platform names User-Agent, browser platform names X-Featureflip-SDK', () => {
    expect(createNodePlatform().identityHeader).toBe('User-Agent');
    expect(createBrowserPlatform().identityHeader).toBe('X-Featureflip-SDK');
  });
});
