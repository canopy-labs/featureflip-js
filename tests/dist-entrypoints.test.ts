import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
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

// #3562: package.json declares `"sideEffects": false`, which tells bundlers they
// may drop any of these files whose exports go unused — and the flag-cleanup
// Action relies on the same promise to delete a stranded bare import. The claim
// is only true while loading a file does nothing observable, so each shipped
// entry point is loaded in its own Node process and must leave exactly the
// trace an empty module leaves. Lives in this file to share the build above:
// a second file building dist/ in parallel would race it.
describe('import-time side effects', () => {
  const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8')) as {
    sideEffects?: unknown;
    exports: unknown;
  };
  const probeScript = resolve(__dirname, 'fixtures/import-probe.mjs');
  const probe = (target: string): unknown =>
    JSON.parse(execFileSync(process.execPath, [probeScript, target], { encoding: 'utf8' }));

  // Every file the exports map can hand a consumer, under any condition.
  const exportedFiles = (node: unknown): string[] =>
    typeof node === 'string'
      ? node.endsWith('.d.ts') ? [] : [node]
      : Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
          key === 'types' ? [] : exportedFiles(value)
        );
  const entryFiles = [...new Set(exportedFiles(pkg.exports))];

  let baseline: unknown;
  beforeAll(() => {
    baseline = probe('data:text/javascript,export {};');
  });

  it('declares sideEffects: false', () => {
    expect(pkg.sideEffects).toBe(false);
  });

  it('covers both module formats of both platform builds', () => {
    expect([...entryFiles].sort()).toEqual([
      './dist/browser.cjs',
      './dist/browser.mjs',
      './dist/node.cjs',
      './dist/node.mjs',
    ]);
  });

  it('notices a module that does work at load time', () => {
    const leaky = probe(
      'data:text/javascript,globalThis.leak = 1; Array.prototype.leak = 1; ' +
        'setInterval(() => {}, 1000); window.addEventListener("load", () => {});'
    );

    expect(leaky).toMatchObject({
      globals: expect.arrayContaining(['leak']),
      patched: ['Array.prototype.leak'],
      timers: ['setInterval'],
      listeners: ['window.addEventListener(load)'],
    });
  });

  it.each(entryFiles)('loading %s has no side effects', (file) => {
    expect(probe(resolve(pkgDir, file))).toEqual(baseline);
  });
});
