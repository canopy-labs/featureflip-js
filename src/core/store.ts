import type { FlagDto, SegmentDto } from './types.js';

/**
 * Called with the keys of every flag affected by a single store mutation.
 * Batched: one call per mutation, not one per key, so a poll that changes 40
 * flags notifies once. Never called with an empty array.
 */
export type FlagChangeListener = (keys: string[]) => void;

export class FlagStore {
  private flags = new Map<string, FlagDto>();
  private segments = new Map<string, SegmentDto>();
  private listeners: FlagChangeListener[] = [];
  private version = 0;

  /**
   * Whether a snapshot has been loaded. The first `init` establishes the
   * baseline rather than reporting every flag as changed — a cold load is not
   * a configuration change.
   */
  private hasSnapshot = false;

  getFlag(key: string): FlagDto | undefined {
    return this.flags.get(key);
  }

  getSegment(key: string): SegmentDto | undefined {
    return this.segments.get(key);
  }

  getAllFlags(): FlagDto[] {
    return Array.from(this.flags.values());
  }

  getVersion(): number {
    return this.version;
  }

  /**
   * Replace the whole snapshot. Used by the initial fetch, every poll tick, and
   * the SSE `sync` event, so it diffs against the previous snapshot and reports
   * only what actually changed — notifying every flag on every poll would make
   * the public update hook useless.
   */
  init(flags: FlagDto[], segments: SegmentDto[], version: number): void {
    const changed = this.hasSnapshot ? this.diffSnapshot(flags, segments) : null;

    // Built first, swapped in only once BOTH loops have succeeded. Mutating the live
    // maps in place left a partial snapshot behind if anything threw part-way: on a
    // cold start `diffSnapshot` is skipped, so a malformed `segments` used to land
    // after the flags had already been applied — flags installed, `version` unset,
    // `hasSnapshot` still false, and no way to tell from the outside (#2315).
    const nextFlags = new Map<string, FlagDto>();
    const nextSegments = new Map<string, SegmentDto>();
    for (const flag of flags) {
      nextFlags.set(flag.key, flag);
    }
    for (const segment of segments) {
      nextSegments.set(segment.key, segment);
    }

    this.flags = nextFlags;
    this.segments = nextSegments;
    this.version = version;
    this.hasSnapshot = true;

    if (changed && changed.length > 0) {
      this.notifyListeners(changed);
    }
  }

  /**
   * Apply a single flag delta (SSE `flag.created` / `flag.updated`).
   *
   * Rejects only a *strictly older* config. Equal versions must be applied:
   * the wire version is second-granular, so two edits to one flag inside the
   * same wall-clock second carry an identical version, and treating equal as
   * stale discarded the second edit outright. With streaming on (the default)
   * polling is disabled, so no later snapshot corrected it and the store
   * evaluated against the pre-edit config until an SSE `sync` or reconnect.
   *
   * Re-applying an identical config is harmless; dropping a real one is not.
   */
  upsert(flag: FlagDto): void {
    const existing = this.flags.get(flag.key);
    if (existing && existing.version > flag.version) {
      return;
    }
    this.flags.set(flag.key, flag);
    this.notifyListeners(this.withPrerequisiteDependents(flag.key));
  }

  delete(key: string): void {
    if (this.flags.delete(key)) {
      this.notifyListeners(this.withPrerequisiteDependents(key));
    }
  }

  /**
   * `key` plus every flag transitively depending on it via a prerequisite.
   *
   * The single-key delta paths (SSE `flag.created` / `flag.updated` /
   * `flag.deleted`) need the same fan-out as a full snapshot diff: the event
   * names one flag, but each of its dependents changes evaluated value too.
   *
   * Reads the post-mutation store, so an upserted flag is included, and a
   * deleted flag's dependents — which still carry the now-dangling
   * prerequisite row — remain reachable.
   */
  private withPrerequisiteDependents(key: string): string[] {
    const changed = new Set<string>([key]);
    addPrerequisiteDependents(this.flags.values(), changed);
    return [...changed];
  }

  onChange(listener: FlagChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Keys of the flags affected by replacing the current snapshot with the given
   * one. A flag counts as affected when it is added, removed, its own config
   * changed, one of the segments its rules reference changed, or one of the
   * flags it names as a prerequisite changed — the latter two alter evaluation
   * outcomes without touching the flag's own config, so without them an SSE
   * `segment.updated` (which refetches the whole snapshot) would report nothing
   * and a toggled prerequisite would never reach its dependents.
   *
   * Compares config content, not `version`. The wire version is deliberately
   * second-granular — eval-api divides its internal epoch-millisecond version
   * by 1000 because published SDKs declare 32-bit version fields — so it is not
   * a sufficient change signal here. Two edits to one flag inside the same
   * wall-clock second carry an identical version, and if a snapshot boundary
   * falls between them the later config lands in the store while a version-only
   * diff reports nothing changed, leaving a consumer that caches per key stale
   * until the next unrelated edit (#2088). `upsert` has no such problem — an SSE
   * delta is its own signal — so only full snapshots need this.
   *
   * Serializing covers every field automatically, so a field added to a DTO is
   * included without anyone remembering to extend a comparison. Bounded by one
   * pass over a snapshot the caller just parsed off the wire.
   *
   * It is key-order sensitive. Snapshot-to-snapshot that is safe — both sides
   * come from the same batch endpoint. It is *not* guaranteed when `previous`
   * was written by `upsert` from the single-flag endpoint, which could order or
   * project its keys differently; the first poll after a delta would then report
   * that key as changed. Harmless and self-limiting — the map is replaced with
   * the batch DTO, so it cannot repeat — and it fails toward a redundant
   * notification rather than a missed one, which is the direction this whole
   * diff is trying to protect.
   *
   * Must be called before the maps are replaced.
   */
  private diffSnapshot(flags: FlagDto[], segments: SegmentDto[]): string[] {
    const changed = new Set<string>();

    const nextFlagKeys = new Set<string>();
    for (const flag of flags) {
      nextFlagKeys.add(flag.key);
      const previous = this.flags.get(flag.key);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(flag)) {
        changed.add(flag.key);
      }
    }
    for (const key of this.flags.keys()) {
      if (!nextFlagKeys.has(key)) {
        changed.add(key);
      }
    }

    const changedSegments = new Set<string>();
    const nextSegmentKeys = new Set<string>();
    for (const segment of segments) {
      nextSegmentKeys.add(segment.key);
      const previous = this.segments.get(segment.key);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(segment)) {
        changedSegments.add(segment.key);
      }
    }
    for (const key of this.segments.keys()) {
      if (!nextSegmentKeys.has(key)) {
        changedSegments.add(key);
      }
    }

    if (changedSegments.size > 0) {
      // Only the incoming flags need scanning: a flag that dropped a reference
      // to a changed segment must have had its own rules edited, which changes
      // its own config and is already reported above.
      for (const flag of flags) {
        // Optional-chained deliberately: `rules` is non-nullable per the DTO,
        // but this runs before the maps are replaced, so a malformed payload
        // throwing here would abort the whole snapshot update and leave the
        // store permanently stale — a far worse failure than one bad flag.
        if (flag.rules?.some((r) => r.segmentKey && changedSegments.has(r.segmentKey))) {
          changed.add(flag.key);
        }
      }
    }

    // Must run last: it walks out from the fully-resolved changed set, so a flag
    // that only the segment scan above pulled in still reaches its dependents.
    addPrerequisiteDependents(flags, changed);

    return [...changed];
  }

  private notifyListeners(keys: string[]): void {
    for (const listener of this.listeners) {
      try {
        listener(keys);
      } catch {
        // Swallow listener errors
      }
    }
  }
}

/**
 * Expands `changed` in place with every flag that transitively depends on an
 * already-changed flag through a prerequisite.
 *
 * A flag's `version` covers its own prerequisite rows but not the flags those
 * rows point at, so toggling a prerequisite bumps only the prerequisite's
 * version. The evaluator resolves prerequisites recursively, so the dependent's
 * value still flips (to its off variation, `PrerequisiteFailed`) — leaving the
 * dependent silently absent from the change notification.
 *
 * Walks reverse edges from the changed set rather than scanning every flag's
 * chain, so cost is proportional to the affected subgraph, not the whole
 * snapshot. Over-reporting here is harmless (a listener re-reads a flag that
 * evaluates the same); under-reporting is the bug being fixed.
 */
function addPrerequisiteDependents(flags: Iterable<FlagDto>, changed: Set<string>): void {
  if (changed.size === 0) return;

  // prerequisite key -> flags naming it. Built from the incoming flags, so a
  // *removed* flag still resolves its dependents: the dependents are still
  // present and still carry the dangling prerequisite row.
  const dependents = new Map<string, string[]>();
  for (const flag of flags) {
    // Optional-chained for the same reason as the segment scan: a malformed
    // payload must not abort the whole snapshot update.
    for (const prereq of flag.prerequisites ?? []) {
      const key = prereq?.prerequisiteFlagKey;
      if (!key) continue;
      const existing = dependents.get(key);
      if (existing) existing.push(flag.key);
      else dependents.set(key, [flag.key]);
    }
  }
  if (dependents.size === 0) return;

  // `changed` doubles as the visited set, so a prerequisite cycle (rejected by
  // the server, but reachable via a malformed payload) terminates instead of
  // looping forever. No depth cap is needed for the same reason — unlike the
  // evaluator, this walk visits each flag at most once.
  const queue = [...changed];
  while (queue.length > 0) {
    const key = queue.pop() as string;
    for (const dependent of dependents.get(key) ?? []) {
      if (!changed.has(dependent)) {
        changed.add(dependent);
        queue.push(dependent);
      }
    }
  }
}
