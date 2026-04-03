import { createHash } from 'crypto';
import { createRequire } from 'module';
import type { Platform } from './types.js';

const require = createRequire(import.meta.url);

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

export function createNodePlatform(): Platform {
  return {
    md5(input: string): Uint8Array {
      return createHash('md5').update(input, 'utf8').digest();
    },

    createEventSource(url: string, headers: Record<string, string>) {
      const { EventSource: EventSourceLib } = require('eventsource') as EventSourceModule;
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
      'User-Agent': 'featureflip-js/0.1.0',
    },

    sseSupportsHeaders: true,
  };
}
