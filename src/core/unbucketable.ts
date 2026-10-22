/**
 * Warn-once reporting for a percentage rollout that skipped a context it
 * could not bucket (#4236). Carries only the flag key, the rule id (or
 * `fallthrough`) and the bucket-by attribute NAME — never a context value.
 */

export interface UnbucketableInfo {
  flagKey: string;
  /** The skipped rule's id, or `null` when the fallthrough rollout was skipped. */
  ruleId: string | null;
  bucketBy: string;
}

const MAX_KEYS = 1000;
const seen = new Set<string>();

/**
 * Logs once per (flagKey, rule id or "fallthrough", bucketBy) per process. The
 * set is capped; once full, unseen keys are dropped silently.
 */
export function warnUnbucketable(
  info: UnbucketableInfo,
  sink: (message: string) => void = (m) => console.warn(m),
): void {
  const where = info.ruleId === null ? 'fallthrough' : `rule ${info.ruleId}`;
  const dedupKey = JSON.stringify([info.flagKey, info.ruleId ?? 'fallthrough', info.bucketBy]);
  if (seen.has(dedupKey) || seen.size >= MAX_KEYS) return;
  seen.add(dedupKey);
  sink(
    `[featureflip] Skipped the percentage rollout in flag "${info.flagKey}" (${where}): the context has no value for "${info.bucketBy}". Pass a stable id in that attribute to include this context in the rollout.`,
  );
}

/** Test-only: clears the process-wide dedup set so tests don't depend on run order. */
export function __resetUnbucketableForTests(): void {
  seen.clear();
}
