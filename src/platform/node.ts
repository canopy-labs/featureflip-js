import { createHash } from 'crypto';
import type { Platform } from './types.js';

interface EventSourceInstance {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  close(): void;
  readyState: number;
}

interface EventSourceModule {
  EventSource: new (
    url: string,
    opts?: { fetch?: typeof globalThis.fetch },
  ) => EventSourceInstance;
}

// eventsource is ESM-only from v5 on, and declares `engines.node >= 22.12`
// because `require()` of an ESM-only package is only unflagged on Node 20.19+
// and 22.12+ — NOT on 22.0-22.11, which sits inside this package's own
// `engines.node >= 20.19.0`. A dynamic `import()` has no such cliff: it has
// worked from both CJS and ESM since Node 12.17, so loading it this way is what
// lets the SDK keep its 20.19 floor while tracking eventsource majors. Measured
// against the built bundles on 20.19.0 / 22.11.0 / 22.12.0 — see
// tests/eventsource-loading.test.ts, which fails if the build ever turns this
// back into a require(). Do NOT "simplify" this to a static import: that would
// make the ESM-only dependency a hard load-time edge of the cjs bundle.
//
// This also retires the `createRequire(import.meta.url)` workaround from #2245
// — with no require() left there is no `import.meta` in the cjs output to go
// undefined, so that failure mode is gone by construction rather than guarded.
async function loadEventSource(): Promise<EventSourceModule['EventSource']> {
  const mod = (await import('eventsource')) as unknown as EventSourceModule;
  return mod.EventSource;
}

export function createNodePlatform(): Platform {
  return {
    md5(input: string): Uint8Array {
      return createHash('md5').update(input, 'utf8').digest();
    },

    async createEventSource(url: string, headers: Record<string, string>) {
      const EventSourceLib = await loadEventSource();
      const es = new EventSourceLib(url, {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          globalThis.fetch(input, {
            ...init,
            headers: { ...init?.headers as Record<string, string>, ...headers },
          }),
      });
      return {
        addEventListener: (type: string, listener: (event: { data: string }) => void) => {
          es.addEventListener(type, listener as (event: unknown) => void);
        },
        close: () => es.close(),
        get readyState() {
          return es.readyState;
        },
      };
    },

    async fetch(url: string, init?: RequestInit): Promise<Response> {
      return globalThis.fetch(url, init);
    },

    extraHeaders: {
      'User-Agent': `featureflip-js/${__SDK_VERSION__}`,
    },

    sseSupportsHeaders: true,
  };
}
