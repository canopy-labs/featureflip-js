import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// #2208: dependabot proposed eventsource 4 -> 5, which is ESM-only and declares
// `engines.node >= 22.12.0`. platform/node.ts loaded it with require() via
// createRequire, and vite keeps it `external`, so the consumer's copy was
// require()d at runtime. require() of an ESM-only package only works where
// require(esm) is unflagged — Node 20.19+ and 22.12+, but NOT 22.0-22.11. Since
// this package declares `engines.node >= 20.19.0`, that bump would have shipped
// ERR_REQUIRE_ESM to a Node range we claim to support.
//
// CI could not see it: the matrix is [20, 22], which setup-node resolves to the
// LATEST patch of each — exactly the two versions where require(esm) works — and
// no test executes the require() at all.
//
// So instead of pinning a magic Node version into the matrix, this asserts the
// underlying contract directly: we must not claim to run on a Node older than
// anything we depend on at runtime.
//
// #2246 then took eventsource 5 by switching that require() to a dynamic
// `import()`, which has no version cliff. A declared floor is therefore no
// longer sufficient evidence of a real one, so the rule gained a waiver list —
// but a waiver is only honoured while the mechanism that justifies it is still
// in the source, so reverting to require() re-arms the original assertion
// instead of silently keeping the exemption. See ENGINE_FLOOR_WAIVERS.

const pkgDir = resolve(__dirname, '..');
const repoRoot = resolve(pkgDir, '../..');

interface Manifest {
  engines?: { node?: string };
  dependencies?: Record<string, string>;
}

const readManifest = (path: string): Manifest =>
  JSON.parse(readFileSync(path, 'utf-8')) as Manifest;

/**
 * Lowest version a semver range admits, as a comparable tuple. Handles the
 * forms that actually appear in `engines.node` (">=20.19.0", "^22.12.0",
 * ">=20 <23", "22.x"); returns null for anything with no concrete floor
 * (e.g. "*"), which the caller treats as "imposes no constraint".
 */
function floorOf(range: string): [number, number, number] | null {
  const match = /(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(range);
  if (!match) return null;
  const part = (value: string | undefined): number =>
    value === undefined || value === 'x' || value === '*' ? 0 : Number(value);
  return [Number(match[1]), part(match[2]), part(match[3])];
}

const format = (v: [number, number, number]): string => v.join('.');
const compare = (a: [number, number, number], b: [number, number, number]): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Resolve a dependency's manifest without going through its `exports` map. */
function findDependencyManifest(name: string): string | null {
  const candidates = [
    resolve(pkgDir, 'node_modules', name, 'package.json'),
    resolve(repoRoot, 'node_modules', name, 'package.json'),
  ];
  return candidates.find(existsSync) ?? null;
}

/**
 * Runtime dependencies allowed to declare a HIGHER engines floor than ours.
 *
 * Only justified when the dependency's floor describes how it is *loaded*
 * rather than what its code needs, and we load it in a way that avoids the
 * cliff. `mechanism` is what makes that true; it is re-checked against the
 * source on every run, so the exemption cannot outlive its own premise.
 */
const ENGINE_FLOOR_WAIVERS: Record<
  string,
  { reason: string; sourceFile: string; mustContain: string; mustNotContain: string }
> = {
  // eventsource 5 declares >=22.12 because it is ESM-only and `require()` of an
  // ESM-only package is unflagged on 20.19+ and 22.12+ but NOT 22.0-22.11. Its
  // code imports no Node builtins and uses no post-20 API, so that floor is
  // about the loader, not the runtime. A dynamic import() has worked from both
  // CJS and ESM since 12.17, so loading it that way removes the cliff entirely.
  // Measured against the BUILT bundles with eventsource 5.1.1 installed:
  // 20.19.0 ok, 22.11.0 ok, 22.12.0 ok — the 22.11 cell that #2208 hit with
  // ERR_REQUIRE_ESM. tests/eventsource-loading.test.ts holds the build side.
  eventsource: {
    reason:
      'ESM-only; loaded via dynamic import(), which has no require(esm) version cliff',
    sourceFile: 'src/platform/node.ts',
    mustContain: "await import('eventsource')",
    mustNotContain: "require('eventsource')",
  },
};

describe('engines compatibility with runtime dependencies', () => {
  const pkg = readManifest(resolve(pkgDir, 'package.json'));
  const declared = pkg.engines?.node;
  const dependencies = Object.keys(pkg.dependencies ?? {});

  it('declares an engines.node range', () => {
    expect(declared).toBeDefined();
    expect(floorOf(declared as string)).not.toBeNull();
  });

  it.each(dependencies)(
    'supports every Node version it claims to, despite %s',
    (name) => {
      const manifestPath = findDependencyManifest(name);
      expect(
        manifestPath,
        `Could not find an installed manifest for "${name}". Run \`npm ci\` at the repo root.`,
      ).not.toBeNull();

      const depRange = readManifest(manifestPath as string).engines?.node;
      if (!depRange) return; // imposes no constraint

      const depFloor = floorOf(depRange);
      if (!depFloor) return;

      const ourFloor = floorOf(declared as string);

      const waiver = ENGINE_FLOOR_WAIVERS[name];
      if (waiver) {
        // The waiver stands only while the source still loads the dependency
        // the way the waiver claims. These assertions ARE the exemption's
        // premise — if either fails the exemption is invalid, and failing here
        // (rather than falling through) names the actual cause.
        const source = readFileSync(resolve(pkgDir, waiver.sourceFile), 'utf-8');
        expect(
          source,
          `"${name}" is exempt from the engines floor rule because it is ${waiver.reason}, ` +
            `but ${waiver.sourceFile} no longer contains \`${waiver.mustContain}\`. ` +
            `Either restore that loading mechanism or drop the waiver and raise engines.node.`,
        ).toContain(waiver.mustContain);
        expect(
          source,
          `"${name}" is exempt from the engines floor rule because it is ${waiver.reason}, ` +
            `but ${waiver.sourceFile} now contains \`${waiver.mustNotContain}\`, which ` +
            `re-introduces the very cliff the waiver assumes is absent. See #2246.`,
        ).not.toContain(waiver.mustNotContain);
        return;
      }

      expect(
        compare(depFloor, ourFloor as [number, number, number]),
        `@featureflip/js declares engines.node "${declared}" (floor ${format(ourFloor as [number, number, number])}), ` +
          `but its runtime dependency "${name}" requires "${depRange}" (floor ${format(depFloor)}). ` +
          `Consumers between those two floors would install successfully and then fail at runtime. ` +
          `Either raise this package's engines.node floor, or hold the dependency back. See #2246.`,
      ).toBeLessThanOrEqual(0);
    },
  );
});
