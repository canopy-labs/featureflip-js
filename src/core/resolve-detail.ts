import { evaluate, evaluateWithSharedMemo } from './evaluator.js';
import type {
  EvaluationContext,
  EvaluationDetail,
  EvaluationReason,
  FlagDto,
  SegmentDto,
} from './types.js';

/**
 * The runtime type a typed accessor requires of the value a flag serves, as
 * reported by `typeof`. Used to detect a type-mismatched read (#2281), which
 * TypeScript cannot catch on its own: its type parameters are erased, so
 * `boolVariation` would otherwise hand back whatever the flag actually served.
 */
export type ExpectedValueType = 'boolean' | 'string' | 'number';

/** What `resolveDetail` needs from its host: hashing, segment lookup, an error hook. */
export interface ResolveDeps {
  md5(input: string): Uint8Array;
  getSegment(key: string): SegmentDto | undefined;
  /**
   * Told about an evaluation that threw, before it degrades to the default with
   * reason `Error`. Optional: the JS core has never surfaced these and does not
   * pass it; the edge SDK logs them.
   */
  onError?(err: unknown, flagKey: string): void;
  /** Told when a rollout serve is skipped because the context can't be bucketed (#4236). */
  onUnbucketable?(info: { flagKey: string; ruleId: string | null; bucketBy: string }): void;
}

/**
 * Turn a flag lookup into the `EvaluationDetail` a variation call returns: the
 * evaluator's result plus every degradation the SDK applies on top of it. Pure,
 * never throws, records nothing — the caller owns analytics and inspectors.
 *
 * Shared by `SharedFeatureflipCore.variationDetail` and `@featureflip/edge`, so
 * the two cannot drift on what a missing flag, a malformed config or a
 * type-mismatched read resolves to.
 *
 * @internal Not exported from any public entry point.
 *
 * @param expected The `typeof` result the caller's typed accessor requires, or
 *   undefined for the generic/JSON accessors. Those take no runtime type — a
 *   TypeScript type parameter is erased — so there is nothing to check them
 *   against and they are left unchecked.
 * @param allFlags Every flag, for prerequisite lookups, or a function returning
 *   them. A function is called inside the guard, so a store that throws while
 *   building the map degrades to `Error` like any other evaluation failure.
 * @param memo A memo shared across a batch of evaluations (e.g. a bootstrap
 *   sweep) so shared prerequisites are evaluated once. Omit for a single read.
 */
export function resolveDetail<T>(
  flag: FlagDto | undefined,
  context: EvaluationContext,
  defaultValue: T,
  deps: ResolveDeps,
  allFlags: Record<string, FlagDto> | (() => Record<string, FlagDto>),
  expected?: ExpectedValueType,
  memo?: Map<string, EvaluationDetail>,
): EvaluationDetail<T> {
  if (!flag) {
    return { value: defaultValue, reason: 'FlagNotFound' };
  }

  try {
    const flags = typeof allFlags === 'function' ? allFlags() : allFlags;
    // Passed straight through, not re-wrapped: this runs on every variation
    // call. The evaluator calls `md5` detached, so callers pass functions that
    // do not use `this` (both do).
    const result = memo
      ? evaluateWithSharedMemo(flag, context, deps, flags, memo)
      : evaluate(flag, context, deps, flags);

    // Malformed config: the evaluator selected a variation key the flag does
    // not define (e.g. a fallthrough/rule naming a since-deleted variation).
    // Degrade to the caller's default and report Error, mirroring the engine's
    // ServeVariation + the C#/Java SDKs (#1989). A variation that genuinely
    // exists with a null value is NOT this case — hence the key lookup rather
    // than a `value === null` check, which cannot tell the two apart.
    const served = result.variationKey
      ? flag.variations.find((v) => v.key === result.variationKey)
      : undefined;
    let reason: EvaluationReason =
      result.variationKey && !served ? 'Error' : result.reason;

    let value = result.value !== undefined && result.value !== null
      ? (result.value as T)
      : defaultValue;

    // A typed accessor asked for a specific JSON type and the SERVED value is
    // not it. Degrade to the caller's default and report Error so the mismatch
    // is detectable, rather than handing back a string where the caller's code
    // expects a boolean (#2281). Checking `result.value` rather than `value`
    // matters: a variation whose value is genuinely null has already been
    // replaced by defaultValue above, and that substitute would pass any check.
    if (expected && typeof result.value !== expected) {
      value = defaultValue;
      reason = 'Error';
    }

    return {
      value,
      variationKey: result.variationKey,
      reason,
      ruleId: result.ruleId,
      prerequisiteKey: result.prerequisiteKey,
    };
  } catch (err) {
    deps.onError?.(err, flag.key);
    return { value: defaultValue, reason: 'Error' };
  }
}
