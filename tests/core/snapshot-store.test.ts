import { describe, it, expect } from 'vitest';
import { createNodePlatform } from '../../src/platform/node.js';
import {
  computeKeyHash,
  encodeEnvelope,
  decodeEnvelope,
  FUTURE_FETCHED_AT_TOLERANCE_MS,
  type DecodedSnapshot,
} from '../../src/core/snapshot-store.js';

const sha = createNodePlatform().sha256Hex!;
const now = 1_800_000_000_000;
const snap: DecodedSnapshot = {
  fetchedAt: now - 5000,
  data: { environment: 'prod', version: 3, flags: [], segments: [] },
};

describe('computeKeyHash', () => {
  it('ignores a trailing slash on the base URL', () => {
    expect(computeKeyHash(sha, 'https://a/', 'k')).toBe(computeKeyHash(sha, 'https://a', 'k'));
  });
  it('differs by key and by URL', () => {
    const h = computeKeyHash(sha, 'https://a', 'k');
    expect(computeKeyHash(sha, 'https://a', 'k2')).not.toBe(h);
    expect(computeKeyHash(sha, 'https://b', 'k')).not.toBe(h);
  });
  it('is 64 hex chars and does not leak the key', () => {
    const h = computeKeyHash(sha, 'https://a', 'secret-key');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('secret-key');
  });
});

describe('envelope', () => {
  const h = computeKeyHash(sha, 'https://a', 'k');
  it('round trips', () => {
    expect(decodeEnvelope(encodeEnvelope(h, snap), h, now)).toEqual({ ok: true, snapshot: snap });
  });
  it('accepts a fetchedAt up to the clock-skew tolerance in the future', () => {
    expect(FUTURE_FETCHED_AT_TOLERANCE_MS).toBe(60_000);
    const atEdge = { ...snap, fetchedAt: now + 60_000 };
    expect(decodeEnvelope(encodeEnvelope(h, atEdge), h, now)).toEqual({ ok: true, snapshot: atEdge });
  });
  it.each([
    ['garbage', () => 'not json{', /JSON/],
    ['empty', () => '', /empty/],
    ['truncated', () => encodeEnvelope(h, snap).slice(0, 30), /JSON/],
    ['v 2', () => JSON.stringify({ v: 2, keyHash: h, fetchedAt: snap.fetchedAt, data: snap.data }), /version/],
    ['other keyHash', () => encodeEnvelope('x'.repeat(64), snap), /different SDK key/],
    ['fetchedAt 61s in the future', () => encodeEnvelope(h, { ...snap, fetchedAt: now + 61_000 }), /future/],
    ['zero fetchedAt', () => encodeEnvelope(h, { ...snap, fetchedAt: 0 }), /positive integer/],
    ['fractional fetchedAt', () => encodeEnvelope(h, { ...snap, fetchedAt: 1.5 }), /positive integer/],
    [
      'missing flags',
      () =>
        JSON.stringify({
          v: 1,
          keyHash: h,
          fetchedAt: snap.fetchedAt,
          data: { environment: 'p', version: 1, segments: [] },
        }),
      /validation/,
    ],
    ['null', () => 'null', /envelope/],
    ['a non-string value', () => ({ data: snap.data, fetchedAt: snap.fetchedAt }), /non-string/],
  ])('rejects %s and names the failed check', (_n, make, why) => {
    const result = decodeEnvelope(make(), h, now);
    expect(result.ok).toBe(false);
    expect((result as { why: string }).why).toMatch(why);
    expect((result as { why: string }).why).not.toContain(h);
  });
});
