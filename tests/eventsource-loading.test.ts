import { beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { resolve } from 'path';

// #2246: the SDK can depend on ESM-only eventsource 5 while keeping its
// `engines.node >= 20.19.0` floor for exactly one reason — platform/node.ts
// loads it with a dynamic `import()` instead of `require()`. require(esm) is
// unflagged on Node 20.19+ and 22.12+ but NOT on 22.0-22.11; import() has no
// such cliff on any supported version.
//
// That reasoning is about the SHIPPED BUNDLE, not the source. The bundler is
// free to rewrite `import()` into `require()` when emitting CommonJS — which is
// a normal, correct thing for a bundler to do, and would silently restore
// ERR_REQUIRE_ESM on Node 22.0-22.11 with nothing in the source to show for it.
// A source-level test cannot see that; the sibling waiver in
// engines-compat.test.ts guards the source half, and this guards the emitted
// half. Together they mean the engines floor is only claimed while both the
// code and the build actually support it.

const pkgDir = resolve(__dirname, '..');
const distDir = resolve(pkgDir, 'dist');

/** The module specifier as a literal, in any quote style the minifier picks. */
const specifier = /[`'"]eventsource[`'"]/g;
/** Matches the call in any quote style the minifier may choose. */
const dynamicImport = /import\(\s*[`'"]eventsource[`'"]\s*\)/;

/**
 * Every place the bundle names "eventsource", with whatever call precedes it.
 *
 * Deliberately structural rather than a `require\(` regex: the minifier renames
 * the binding, so a `createRequire` path emits `n(\`eventsource\`)` and a textual
 * search for "require(" silently finds nothing — which is exactly how a
 * reverted mechanism would slip through looking green.
 */
function loadSites(code: string): { call: string; isDynamicImport: boolean }[] {
  const sites: { call: string; isDynamicImport: boolean }[] = [];
  for (const match of code.matchAll(specifier)) {
    const before = code.slice(Math.max(0, match.index - 40), match.index);
    const call = /([A-Za-z_$][\w$]*)?\(\s*$/.exec(before);
    sites.push({
      call: `${call?.[1] ?? '<none>'}(${match[0]})`,
      isDynamicImport: /(^|[^.\w$])import\(\s*$/.test(before),
    });
  }
  return sites;
}

const bundles = ['node.cjs', 'node.mjs'];

beforeAll(() => {
  // CI runs the test job before the build job, so dist/ is usually absent here.
  if (!existsSync(resolve(distDir, 'node.cjs'))) {
    execFileSync('npm', ['run', 'build'], { cwd: pkgDir, stdio: 'inherit' });
  }
}, 180_000);

describe('eventsource loading in the built bundles', () => {
  it.each(bundles)('%s loads eventsource with a dynamic import', (bundle) => {
    const code = readFileSync(resolve(distDir, bundle), 'utf-8');

    expect(
      dynamicImport.test(code),
      `dist/${bundle} does not load "eventsource" with a dynamic import(). ` +
        `That is what lets this package depend on an ESM-only eventsource while ` +
        `declaring engines.node >= 20.19.0. See #2246.`,
    ).toBe(true);
  });

  it.each(bundles)('%s reaches eventsource ONLY by dynamic import', (bundle) => {
    const code = readFileSync(resolve(distDir, bundle), 'utf-8');
    const offenders = loadSites(code).filter((site) => !site.isDynamicImport);

    expect(
      offenders.map((site) => site.call),
      `dist/${bundle} reaches "eventsource" by something other than import(). ` +
        `eventsource is ESM-only from v5 on, so any require() path — including a ` +
        `minified createRequire alias, which is why this checks the call site ` +
        `rather than the text "require" — throws ERR_REQUIRE_ESM on Node ` +
        `22.0-22.11, inside our declared engines.node range. CI cannot catch it ` +
        `because the [20, 22] matrix resolves to the latest patch of each, the ` +
        `two versions where it happens to work. Restore the dynamic import in ` +
        `src/platform/node.ts, or raise engines.node to >= 22.12.0. See #2246.`,
    ).toEqual([]);
  });
});

describe('the real eventsource, through the built bundle', () => {
  // The checks above are static: they prove the SHAPE of the load is right.
  // This one proves the load actually WORKS — the dynamic import resolves the
  // installed eventsource, the platform constructs it, and a server-sent event
  // arrives through the adapter. That is what would catch a future eventsource
  // major changing its export or its options contract, which no amount of
  // inspecting the call site can see.
  it('opens a stream and receives an event', async () => {
    const { createNodePlatform } = (await import(resolve(distDir, 'node.mjs'))) as {
      createNodePlatform: () => {
        createEventSource: (
          url: string,
          headers: Record<string, string>,
        ) => Promise<{
          addEventListener: (t: string, l: (e: { data: string }) => void) => void;
          close: () => void;
        }>;
      };
    };

    const received: string[] = [];
    const seenAuth: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seenAuth.push(req.headers.authorization);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('event: sync\ndata: {"ok":true}\n\n');
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;

    try {
      const es = await createNodePlatform().createEventSource(
        `http://127.0.0.1:${port}/v1/sdk/stream`,
        { authorization: 'sdk-key' },
      );
      es.addEventListener('sync', (event) => received.push(event.data));

      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5000 });
      es.close();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    expect(received[0]).toBe('{"ok":true}');
    // The platform injects SDK headers through eventsource's `fetch` option —
    // the reason the SDK key does not have to ride in the query string on Node.
    expect(seenAuth[0]).toBe('sdk-key');
  }, 20_000);
});
