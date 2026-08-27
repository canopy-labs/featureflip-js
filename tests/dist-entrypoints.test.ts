import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { resolve } from 'path';

// #2245: `dist/node.cjs` threw at module load in every published version, so
// `require('@featureflip/js')` was dead on arrival while `import` worked fine.
// platform/node.ts builds its require with `createRequire(import.meta.url)`, and
// `import.meta` has no meaning in the cjs output — rolldown substitutes an empty
// object, so the shipped bundle read `createRequire({}.url)`, i.e.
// createRequire(undefined), which throws ERR_INVALID_ARG_VALUE. It sat at module
// top level, so nothing could catch it and no config avoided it.
//
// It survived from the SDK's first commit to 2.5.3 because nothing ever loaded
// the built artifact: every other test imports TypeScript source through
// vitest's ESM pipeline, which never produces the cjs output at all. So this
// deliberately goes through the real `dist/` files with Node's own require,
// bypassing vitest's module interception — a source-level test cannot see this
// class of bug.

const pkgDir = resolve(__dirname, '..');
const distDir = resolve(pkgDir, 'dist');
const nodeRequire = createRequire(import.meta.url);

interface NodeEntry {
  createNodePlatform?: () => { extraHeaders?: Record<string, string> };
  FeatureflipClient?: unknown;
}

beforeAll(() => {
  // CI runs the test job before the build job, so dist/ is usually absent here.
  if (!existsSync(resolve(distDir, 'node.cjs'))) {
    execFileSync('npm', ['run', 'build'], { cwd: pkgDir, stdio: 'inherit' });
  }
}, 180_000);

describe('built entrypoints', () => {
  it('loads the CommonJS node build', () => {
    const entry = nodeRequire(resolve(distDir, 'node.cjs')) as NodeEntry;

    expect(typeof entry.createNodePlatform).toBe('function');
    expect(entry.FeatureflipClient).toBeDefined();
  });

  it('builds a working platform from the CommonJS node build', () => {
    const { createNodePlatform } = nodeRequire(resolve(distDir, 'node.cjs')) as Required<
      Pick<NodeEntry, 'createNodePlatform'>
    >;

    expect(createNodePlatform().extraHeaders?.['User-Agent']).toMatch(/^featureflip-js\//);
  });

  it('loads the ESM node build', async () => {
    const entry = (await import(resolve(distDir, 'node.mjs'))) as NodeEntry;

    expect(typeof entry.createNodePlatform).toBe('function');
  });
});
