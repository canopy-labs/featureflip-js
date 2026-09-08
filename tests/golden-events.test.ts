import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { FeatureflipClient } from '../src/client.js';
import type { Platform } from '../src/platform/types.js';

// The eventPayloadVectors class locks what identify() and track() actually put on
// the wire: {type, flagKey, userId?, variation?, timestamp, metadata?}.
//
// That had no executable spec at all, which is the direct cause of #2359 — a
// three-way payload divergence across six SDKs (js/node/python forwarded the
// caller's attributes as `metadata`; php/go/ruby discarded them) sat unnoticed
// indefinitely. Nothing compared an emitted event against an expected shape, and
// the receiving end reduces every event to a counter tuple, so no downstream
// assertion caught it either.
//
// Hand-authored, because the engine emits no events: it returns an
// EvaluationResult, and the payload is built a layer above that. See
// tools/golden-vectors/README.md for the full runner contract.

interface EventVector {
  id: string;
  description: string;
  kind: 'identify' | 'track';
  requires?: string[];
  context: Record<string, unknown>;
  eventKey?: string;
  metadata?: Record<string, unknown>;
  expect: Record<string, unknown>;
}

const vectors = (
  JSON.parse(readFileSync(new URL('./golden/vectors.json', import.meta.url), 'utf8')) as {
    eventPayloadVectors: EventVector[];
  }
).eventPayloadVectors;

// An ISO-8601 instant that designates UTC. Deliberately not an equality check:
// the precision and the zero-offset spelling differ legitimately per SDK, so a
// literal expectation would lock in a divergence rather than a contract.
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|\+00:00)$/;

// The context capabilities this SDK has. A vector requiring anything outside this
// set is skipped explicitly, so a structural gap can't masquerade as a pass. js
// takes a plain object, so it has both: the identity spelling is observable, and a
// context can carry attributes with no identity at all.
const CAPABILITIES = new Set(['mapContext', 'anonymousContext']);

function md5(input: string): Uint8Array {
  return createHash('md5').update(input, 'utf8').digest();
}

function platformCapturing(): Platform & { fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ environment: 'test', version: 1, flags: [], segments: [] }),
  });
  return {
    md5,
    createEventSource: () => ({
      addEventListener: () => {},
      close: () => {},
      readyState: 2,
    }),
    fetch: fetchMock,
    fetchMock,
  } as unknown as Platform & { fetchMock: ReturnType<typeof vi.fn> };
}

/**
 * The events as they were SERIALIZED for /v1/sdk/events. Reading the request
 * body rather than the object behind it is the point: omission is a
 * serialization-time property, and an absent optional is exactly what #2359 was
 * about.
 */
function capturedEvents(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const [url, init] of fetchMock.mock.calls) {
    if (typeof url === 'string' && url.endsWith('/v1/sdk/events') && init?.body) {
      events.push(...JSON.parse(init.body as string).events);
    }
  }
  return events;
}

describe('golden: event payload vectors', () => {
  afterEach(async () => {
    await FeatureflipClient.resetForTesting();
  });

  it('has vectors to run', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  let executed = 0;

  for (const v of vectors) {
    if ((v.requires ?? []).some((c) => !CAPABILITIES.has(c))) continue;
    executed++;

    it(`${v.id}: ${v.description}`, async () => {
      const platform = platformCapturing();
      const client = FeatureflipClient.get(
        { sdkKey: `events-${v.id}`, baseUrl: 'http://localhost:0', streaming: false },
        platform,
      );

      try {
        await client.waitForInitialization();

        if (v.kind === 'identify') {
          client.identify(v.context);
        } else if ('metadata' in v) {
          client.track(v.eventKey!, v.context, v.metadata);
        } else {
          // No `metadata` key at all -> the argument is omitted, which must put
          // the same bytes on the wire as an explicitly empty bag.
          client.track(v.eventKey!, v.context);
        }

        await client.flush();

        const events = capturedEvents(platform.fetchMock);
        expect(events).toHaveLength(1);
        const event = events[0];

        // The EXACT field set, not a subset: #2359 was a field being present in
        // three SDKs and absent in three, which a subset assertion cannot see.
        expect(Object.keys(event).sort()).toStrictEqual(
          [...Object.keys(v.expect), 'timestamp'].sort(),
        );

        for (const [field, expected] of Object.entries(v.expect)) {
          expect(event[field]).toStrictEqual(expected);
        }

        expect(event.timestamp).toMatch(UTC_INSTANT);
      } finally {
        await client.close();
      }
    });
  }

  // A runner that silently skips everything is worse than no runner at all.
  it('executed the expected number of vectors', () => {
    expect(executed).toBeGreaterThanOrEqual(13);
  });
});
