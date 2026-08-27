import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createNodePlatform } from '../src/platform/node.js';

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf-8'),
) as { version: string };

describe('createNodePlatform', () => {
  // #2141: the User-Agent advertised 0.1.0 across the whole 2.x line because a
  // literal nobody was obliged to touch had gone stale. It now interpolates
  // __SDK_VERSION__, injected by vite `define` from package.json. Nothing
  // asserted either half, so this pins both: that the version is the real
  // shipped one, and that whatever config loads this source supplies the
  // define at all (without it, constructing the platform throws
  // `__SDK_VERSION__ is not defined` — which is how the smoke suite broke).
  it('reports the package version in its User-Agent', () => {
    const platform = createNodePlatform();

    expect(platform.extraHeaders?.['User-Agent']).toBe(`featureflip-js/${pkg.version}`);
  });

  it('does not advertise a placeholder version', () => {
    const userAgent = createNodePlatform().extraHeaders?.['User-Agent'];

    expect(userAgent).not.toContain('0.1.0');
    expect(userAgent).not.toContain('undefined');
  });
});
