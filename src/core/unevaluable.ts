import type {
  FlagDto,
  GetFlagsResponse,
  SegmentDto,
  ServeConfigDto,
} from './types.js';

/**
 * Entity-level drop for enum values this SDK build cannot evaluate (#2402).
 *
 * `ServeType` and `ConditionLogic` are the two enums that are BOTH carried on the wire
 * as strings AND consulted by the evaluator, and each dispatches on a two-way branch
 * with no third arm:
 *
 * ```
 * serve.type === 'Fixed' ? fixed : ROLLOUT
 * logic      === 'And'   ? every : SOME
 * ```
 *
 * So an unrecognised value does not fail — it takes the ELSE arm. `conditionLogic:
 * 'Xor'` evaluates as OR, turning a segment meant to require ALL of its conditions into
 * one matching ANY of them: the rule fails OPEN and over-targets. That is the same
 * hazard `validate-snapshot.ts` closes for the *integer* form (#2279), one line away —
 * but a type check only catches the wrong JSON type, and `'Xor'` is a perfectly good
 * string.
 *
 * Neither of the two obvious fixes works:
 *
 * - **Tolerate and store it**, the way an unknown `FlagType` is tolerated (#2401), is
 *   the silent mis-evaluation above. `FlagType` is safe to tolerate precisely because
 *   NOTHING evaluates it; these two are consulted.
 * - **Reject the payload**, the way a type violation is rejected, means one additive
 *   server change takes down every flag on a pinned client — the #2372/#2395 outage
 *   shape.
 *
 * So the containing entity goes instead. The caller gets their default for exactly the
 * affected flag, through the `FlagNotFound` path the SDK already implements, and every
 * other flag keeps serving. Dropping a SEGMENT leaves rules pointing at it dangling;
 * that is safe because `evaluator.ts` already treats an unresolvable `segmentKey` as
 * no-match (#1459), so the cascade fails CLOSED — pinned by the engine-generated
 * `f-segment-unresolvable` golden vector rather than asserted here.
 *
 * Runs AFTER `validateSnapshot`, never instead of it: this handles an unknown NAME,
 * that handles a wrong TYPE, and the two are different axes.
 *
 * Scoped deliberately to a NON-EMPTY unrecognised value. An empty string is the field
 * being ABSENT, which is the missing-required-field axis, not this one — and the SDKs
 * already, deliberately, disagree there: ruby, python and php default an absent
 * `conditionLogic` to `'And'`, while `validateSnapshot` rejects the whole payload for a
 * missing `fallthrough`. Dropping the entity on `''` would not converge that
 * divergence, it would add a fourth behaviour, and it would change the handling of
 * payloads that work today over a case the server never emits. Keeping the check to
 * values that are present and unrecognised makes this change purely additive.
 */

const SERVE_TYPES: ReadonlySet<string> = new Set(['Fixed', 'Rollout']);
const CONDITION_LOGIC: ReadonlySet<string> = new Set(['And', 'Or']);

/**
 * Why this flag cannot be evaluated, or `null` if it can.
 *
 * Returns a human-readable reason rather than a boolean so the caller's diagnostic can
 * name the field and the value actually received — the one detail an operator
 * debugging a vanished flag needs.
 */
export function unevaluableFlagReason(flag: FlagDto): string | null {
  const fallthrough = serveReason(flag?.fallthrough, 'fallthrough');
  if (fallthrough) return fallthrough;

  for (const rule of flag?.rules ?? []) {
    const serve = serveReason(rule?.serve, `rule[${rule?.id}].serve`);
    if (serve) return serve;

    for (const group of rule?.conditionGroups ?? []) {
      if (group?.operator && !CONDITION_LOGIC.has(group.operator)) {
        return `rule[${rule?.id}].conditionGroup.operator "${group?.operator}" is not a condition logic this SDK version understands`;
      }
    }
  }

  return null;
}

/** Why this segment cannot be evaluated, or `null` if it can. */
export function unevaluableSegmentReason(segment: SegmentDto): string | null {
  if (segment?.conditionLogic && !CONDITION_LOGIC.has(segment.conditionLogic)) {
    return `conditionLogic "${segment?.conditionLogic}" is not a condition logic this SDK version understands`;
  }
  return null;
}

function serveReason(serve: ServeConfigDto, path: string): string | null {
  if (serve?.type && !SERVE_TYPES.has(serve.type)) {
    return `${path}.type "${serve?.type}" is not a serve type this SDK version understands`;
  }
  return null;
}

export interface DroppedEntity {
  kind: 'flag' | 'segment';
  key: string;
  reason: string;
}

export interface FilteredSnapshot {
  flags: FlagDto[];
  segments: SegmentDto[];
  dropped: DroppedEntity[];
}

/**
 * Split a validated snapshot into the entities this SDK can evaluate and the ones it
 * cannot. Never throws: an unknown enum name is a forward-compatibility event, not a
 * contract violation, and the healthy remainder must still apply.
 */
export function dropUnevaluableEntities(data: GetFlagsResponse): FilteredSnapshot {
  const dropped: DroppedEntity[] = [];

  const flags = data.flags.filter((flag) => {
    const reason = unevaluableFlagReason(flag);
    if (reason) dropped.push({ kind: 'flag', key: flag?.key, reason });
    return reason === null;
  });

  const segments = data.segments.filter((segment) => {
    const reason = unevaluableSegmentReason(segment);
    if (reason) dropped.push({ kind: 'segment', key: segment?.key, reason });
    return reason === null;
  });

  return { flags, segments, dropped };
}
