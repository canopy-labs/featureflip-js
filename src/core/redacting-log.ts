/**
 * Strips the SDK key out of anything the SDK logs.
 *
 * Failure paths report the underlying error, and that error comes from a
 * fetch/EventSource implementation the SDK does not control: the SDK sends the
 * key as the `Authorization` header (and, for SSE, in the stream URL), so an
 * error that quotes the request would hand the credential to whatever the host
 * logs to (#5167). Applied once, when the core is built, rather than at each
 * call site, so it covers every warning that exists and any added later.
 *
 * @internal Not part of the public API.
 */

const REPLACEMENT = '[redacted]';

/**
 * Below this, the value is not treated as a credential. A real key is
 * `sdk_server_`/`sdk_client_` plus 43 base64url characters (54 total, always);
 * redacting something short like `k` would corrupt every line it appears in.
 */
export const MIN_REDACTABLE_LENGTH = 20;

const MAX_DEPTH = 8;
const PLACEHOLDER_OBJECT = '[redacted object]';
const PLACEHOLDER_DEPTH = '[redacted: nested too deeply]';
const PLACEHOLDER_FAILED = '[redacted: unrenderable]';

export type Warn = (...args: unknown[]) => void;

interface Ctx {
  secret: string;
  /** original -> its redacted copy, set BEFORE recursing so cycles and repeats resolve to the copy. */
  copies: Map<object, unknown>;
}

const isError = (v: object): v is Error =>
  v instanceof Error || Object.prototype.toString.call(v) === '[object Error]';

function redact(value: unknown, ctx: Ctx, depth: number): unknown {
  if (typeof value === 'string') return value.split(ctx.secret).join(REPLACEMENT);
  if (value === null || typeof value !== 'object') return value;
  if (ctx.copies.has(value)) return ctx.copies.get(value);
  // Never hand back the original once we can no longer inspect it.
  if (depth >= MAX_DEPTH) return PLACEHOLDER_DEPTH;

  if (isError(value)) return redactError(value, ctx, depth);

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    ctx.copies.set(value, copy);
    let changed = false;
    for (const item of value) {
      const r = redact(item, ctx, depth + 1);
      if (r !== item) changed = true;
      copy.push(r);
    }
    if (!changed) {
      ctx.copies.set(value, value);
      return value;
    }
    return copy;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const copy: Record<string, unknown> = {};
    ctx.copies.set(value, copy);
    let changed = false;
    for (const [k, v] of Object.entries(value)) {
      const r = redact(v, ctx, depth + 1);
      if (r !== v) changed = true;
      copy[k] = r;
    }
    if (!changed) {
      ctx.copies.set(value, value);
      return value;
    }
    return copy;
  }

  // Class instances, Map, Set, URL, Headers, Request/Response...: a clean one
  // keeps its reference; a flagged one is never passed through.
  ctx.copies.set(value, value);
  if (objectContainsSecret(value, ctx, depth)) {
    ctx.copies.set(value, PLACEHOLDER_OBJECT);
    return PLACEHOLDER_OBJECT;
  }
  return value;
}

function objectContainsSecret(value: object, ctx: Ctx, depth: number): boolean {
  const has = (v: unknown) => redact(v, ctx, depth + 1) !== v;
  const v = value as Record<string, unknown> & { entries?: () => Iterable<unknown> };
  try {
    if (value instanceof Map || value instanceof Set) {
      if (has([...value])) return true;
    } else if (typeof v.entries === 'function' && Symbol.iterator in value) {
      // Headers, URLSearchParams, FormData...
      if (has([...v.entries()])) return true;
    }
    if (typeof v.url === 'string' && has(v.url)) return true; // Request/Response
    if (v.headers && typeof v.headers === 'object' && has(v.headers)) return true;
    if (has(Object.values(value))) return true;
  } catch {
    // fall through to the string renderings
  }
  try {
    if (has(String(value))) return true;
  } catch {
    // ignore
  }
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string' && has(json)) return true;
  } catch {
    // ignore
  }
  return false;
}

function redactError(err: Error, ctx: Ctx, depth: number): Error {
  const e = err as Error & { errors?: unknown; cause?: unknown };
  const message = redact(e.message, ctx, depth + 1) as string;
  const Aggregate = (globalThis as { AggregateError?: new (errs: unknown[], m?: string) => Error })
    .AggregateError;
  let copy: Error;
  if (Array.isArray(e.errors) && Aggregate) {
    const errors: unknown[] = [];
    copy = new Aggregate(errors, message);
    ctx.copies.set(err, copy);
    for (const x of e.errors) errors.push(redact(x, ctx, depth + 1));
  } else {
    copy = new Error(message);
    ctx.copies.set(err, copy);
  }
  copy.name = redact(e.name, ctx, depth + 1) as string;
  if (typeof e.stack === 'string') copy.stack = redact(e.stack, ctx, depth + 1) as string;
  if (e.cause !== undefined) {
    (copy as { cause?: unknown }).cause = redact(e.cause, ctx, depth + 1);
  }
  for (const k of Object.keys(e)) {
    if (k === 'message' || k === 'stack' || k === 'cause' || k === 'name' || k === 'errors') continue;
    try {
      (copy as unknown as Record<string, unknown>)[k] = redact(
        (e as unknown as Record<string, unknown>)[k],
        ctx,
        depth + 1,
      );
    } catch {
      (copy as unknown as Record<string, unknown>)[k] = PLACEHOLDER_FAILED;
    }
  }
  return copy;
}

/** A `console.warn` that replaces the exact SDK key with `[redacted]` in every argument. */
export function createRedactingWarn(secret: string): Warn {
  if (typeof secret !== 'string' || secret.length < MIN_REDACTABLE_LENGTH) {
    return (...args) => console.warn(...args);
  }
  return (...args) => {
    const ctx: Ctx = { secret, copies: new Map() };
    const safe = args.map((a) => {
      try {
        return redact(a, ctx, 0);
      } catch {
        return PLACEHOLDER_FAILED;
      }
    });
    console.warn(...safe);
  };
}
