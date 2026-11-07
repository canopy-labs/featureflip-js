import type { GetFlagsResponse } from './types.js';
import { validateSnapshot } from './validate-snapshot.js';

/**
 * Pluggable persistence for the last good config snapshot: an opaque text
 * store. The SDK owns the stored text end to end (envelope, environment check
 * and every startup reason), so a store only has to hand back exactly what it
 * was last given. One store instance may safely be given to several SDK keys:
 * the SDK rejects text written for a different SDK key or base URL itself.
 *
 * The wrapper the core uses around a store never lets it throw; a custom store
 * may still reject, and that is treated as "no snapshot" / "write failed".
 */
export interface SnapshotStore {
  /** Return the text last stored, or undefined if nothing is stored. */
  get(): Promise<string | undefined>;
  /** Store the text, replacing any previous value. */
  put(text: string): Promise<void>;
}

/** Why a flag was served from persisted data rather than a live fetch. */
export type SnapshotReason = 'snapshot' | 'snapshot-expired' | 'snapshot-invalid';

/** A decoded, validated snapshot record. Internal: stores only ever see text. */
export interface DecodedSnapshot {
  data: GetFlagsResponse;
  /** Wall-clock time (integer epoch ms) the state was written. */
  fetchedAt: number;
}

/**
 * How far in the future a stored `fetchedAt` may be and still be accepted
 * (its age is clamped to 0). Covers small clock skew between the process that
 * wrote the snapshot and the one reading it.
 */
export const FUTURE_FETCHED_AT_TOLERANCE_MS = 60_000;

/**
 * While a client is live and healthy, an unchanged state is rewritten (to
 * refresh its `fetchedAt`) at most this often. Changed content is never throttled.
 */
export const SNAPSHOT_REFRESH_INTERVAL_MS = 300_000;

/**
 * Identify the (baseUrl, sdkKey) pair without storing the key. The hash function
 * is injected because the core is shared with the browser build and must not
 * import node:crypto.
 */
export function computeKeyHash(
  sha256Hex: (text: string) => string,
  baseUrl: string,
  sdkKey: string,
): string {
  const url = baseUrl.replace(/\/+$/, '');
  return sha256Hex(`${url}\n${sdkKey}`);
}

export function encodeEnvelope(keyHash: string, s: DecodedSnapshot): string {
  return encodeEnvelopeText(keyHash, s.fetchedAt, JSON.stringify(s.data));
}

/**
 * The same bytes as `JSON.stringify({ v: 1, keyHash, fetchedAt, data })`, from
 * an already serialized `data`, so a persist serializes the state only once.
 */
export function encodeEnvelopeText(keyHash: string, fetchedAt: number, dataText: string): string {
  return `{"v":1,"keyHash":${JSON.stringify(keyHash)},"fetchedAt":${fetchedAt},"data":${dataText}}`;
}

/**
 * Parse and check stored text. `why` names the failed check for the log; it
 * never includes snapshot contents or the SDK key. Age is not checked here.
 */
export function decodeEnvelope(
  text: unknown,
  keyHash: string,
  now: number,
): { ok: true; snapshot: DecodedSnapshot } | { ok: false; why: string } {
  if (typeof text !== 'string') return { ok: false, why: 'store returned a non-string value' };
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch {
    return { ok: false, why: text.length === 0 ? 'empty text' : 'not valid JSON' };
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { ok: false, why: 'not a snapshot envelope' };
  }
  const e = env as { v?: unknown; keyHash?: unknown; fetchedAt?: unknown; data?: unknown };
  if (e.v !== 1) return { ok: false, why: 'unsupported envelope version' };
  if (e.keyHash !== keyHash) {
    return { ok: false, why: 'written for a different SDK key or base URL' };
  }
  const f = e.fetchedAt;
  if (typeof f !== 'number' || !Number.isInteger(f) || f <= 0) {
    return { ok: false, why: 'fetchedAt is not a positive integer' };
  }
  if (f > now + FUTURE_FETCHED_AT_TOLERANCE_MS) {
    return { ok: false, why: 'fetchedAt is in the future' };
  }
  const data = e.data as GetFlagsResponse | null | undefined;
  if (!data || typeof data !== 'object') return { ok: false, why: 'missing data' };
  try {
    validateSnapshot(data);
  } catch {
    return { ok: false, why: 'data failed payload validation' };
  }
  return { ok: true, snapshot: { data, fetchedAt: f } };
}

/**
 * Wraps a user-supplied store so that no call can throw or reject: a failure
 * is logged and treated as a miss (get) or a dropped write (put).
 */
export class SafeSnapshotStore {
  constructor(readonly inner: SnapshotStore) {}

  /** The raw stored value (null normalized to undefined). Never rejects. */
  async get(): Promise<unknown> {
    try {
      return (await this.inner.get()) ?? undefined;
    } catch (err) {
      console.warn('[featureflip] snapshot store read failed:', err);
      return undefined;
    }
  }

  async put(text: string): Promise<void> {
    try {
      await this.inner.put(text);
    } catch (err) {
      console.warn('[featureflip] snapshot store write failed:', err);
    }
  }
}
