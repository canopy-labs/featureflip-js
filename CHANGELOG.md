# Changelog

## 2.8.0 — 2026-08-26

### Changed

- A `Before`/`After` date operand must now be ISO-8601 or a Unix timestamp in seconds. Non-ISO formats that `Date.parse` accepted — `05/15/2023`, `Jan 1 2024`, `January 1, 2024`, `2024.01.01`, `2024/01/01`, `2024-1-1` — match nothing instead of resolving in the **host's local timezone**. That timezone dependence is the reason this is a fix rather than a tightening for its own sake: the same saved targeting rule produced a different instant per host, so in the browser a flag could evaluate differently for two users purely because of where they were. It is the same defect class as the bare-integer operands fixed in 2.4.0 and the NUL-bearing ones fixed in 2.7.1, reached through the third and last remaining path. The go, java, python, ruby and php SDKs have always rejected these formats, so this converges the SDKs rather than making this one an outlier. (#2480)
- Date operands are now case-sensitive: `2024-01-31t09:30:00z` matches nothing where `2024-01-31T09:30:00Z` matches. This falls out of adopting the other SDKs' grammar verbatim, and matches what those five have always done. (#2480)

- Not every change here is a narrowing: a decimal on the minutes position (`2024-01-31T09:30.5`) is now read as a fraction of seconds and matches, where `Date.parse` returned `NaN` and it matched nothing. The go, java, python, ruby and php SDKs have always read it that way — it falls out of their grammar making the seconds and the fraction independently optional — so this converges with them. It is one of the few places this release moves away from the evaluation engine, which rejects the shape. (#2480)

**If you have a targeting rule using one of these formats**, rewrite the operand as ISO-8601 (`2023-05-15`, `2023-05-15T09:30:00Z`, `2023-05-15T09:30:00+05:00`) or as a Unix timestamp in seconds. The Management API now rejects a non-ISO date operand on write, so a rule saved from this release onward cannot carry one.

- A `Before`/`After` date operand that matches the ISO grammar but names no real calendar day now matches nothing, where it previously **rolled over into the following month**. `2024-02-30` resolved to 2024-03-01, `2023-02-29` (2023 is not a leap year) to 2023-03-01 and `2024-04-31` to 2024-05-01 — so a rule evaluated against a date its author never wrote. The evaluation engine and the C#, Go, Python and Java SDKs have always rejected these, so this converges the SDKs rather than making this one an outlier; until now a single saved rule could serve different variations to two users purely by which SDK their service ran. Follows #2480, which pinned the date *grammar* — an unreal day is **inside** that grammar, because a character class cannot express "is a real day", so the grammar guard was silent on it. (#2491)

- The leap-year rule is applied in full, including the century exception: `1900-02-29` and `2100-02-29` match nothing (divisible by 100 but not 400), while `2000-02-29` and `2024-02-29` continue to match. The check runs on the operand's **written** date, before any offset is applied, so `2024-02-30T00:00:00+05:00` is rejected even though it would resolve to 2024-02-29T19:00Z — a date that does exist. (#2491)

**If you have a targeting rule using one of these operands**, rewrite it as the date you meant. The Management API has rejected an unreal day on write since #2480 (`PortableDateOperand` round-trips every grammar-matched operand through the engine's parser), so a rule saved from that release onward cannot carry one — only rules saved earlier are affected.

### Fixed

- A `Before`/`After` date operand that resolves outside the representable date range now matches nothing, where it previously resolved to a real instant. The evaluation engine parses with `DateTimeOffset.TryParse`, so its accepted range is 0001-01-01T00:00:00Z to 9999-12-31T23:59:59.999Z and it matches nothing outside that; this SDK resolved past **both** ends, so a single saved rule served different variations to two users purely by which SDK their service ran. (#2500)

- The two reachable shapes are a **year-zero** operand and an operand carried out of range **by its offset**. `0000-01-01` is inside the ISO grammar and is a real proleptic date (`0000-02-29` exists — year 0 is divisible by 400), so neither #2480's grammar guard nor #2491's calendar-day check excluded it. Separately, `[0-9]{4}` constrains only the **written** year while a timezone offset moves the resolved instant, so `0001-01-01T00:00:00+05:00` fell below the floor and `9999-12-31T23:59:59-05:00` rose above the ceiling from years the grammar allows. The check therefore runs on the **resolved** instant — deliberately unlike #2491's, which runs on the written date. (#2500)

- The exact boundaries remain accepted: `0001-01-01`, `0001-01-01T05:00:00+05:00`, `9999-12-31T23:59:59Z` and `9999-12-31T18:59:59-05:00` all still resolve. (#2500)

**If you have a targeting rule using one of these operands**, rewrite it as the date you meant. The Management API has rejected them on write since #2480 (`PortableDateOperand` round-trips every grammar-matched operand through the engine's own parser, so it inherits the range bound), meaning only rules saved before that release can carry one.

## 2.7.1 — 2026-08-24

### Fixed

- A date operand carrying a NUL or an ASCII separator character no longer resolves to an arbitrary instant in the **host's local timezone**. `Date.parse` read `"5\u0000"` as the calendar date "May 1", so the same flag config evaluated differently for users in different timezones — the same defect class fixed for bare integers in 2.4.0, reached through a different path. (#2468)
- A date operand is now trimmed of exactly the whitespace the evaluation engine trims (tab, newline, vertical tab, form feed, carriage return and space), and is rejected outright if it still carries a NUL, another control character, or a non-ASCII whitespace character. Each SDK had been relying on its own language's `trim`, and no two of those cover the same set, so the same operand could match on one SDK and match nothing on another. (#2468)
- An ISO-8601 operand naming hour 24 (`2024-01-01T24:00:00`) matches nothing, rather than rolling over to the next day. (#2468)

## 2.7.0 — 2026-08-24

### Fixed

- A non-2xx from the events endpoint is now detected. `fetch` resolves for 4xx/5xx as readily as for 200 and the sender never checked `response.ok`, so a rejected batch of analytics events looked exactly like a delivered one — dropped with no log and no counter. (#2456)
- Analytics events now survive a transient failure of the events endpoint. The batch is spliced out of the queue before it is sent, so any rejection discarded it outright — and the public edge answers this endpoint with a 503 at a low but constant rate, so events were being lost steadily. A retryable failure (5xx, 429, transport fault) returns the batch to the front of the queue for the next flush; a permanent one (401/403/400) still drops it, because retrying a rejected SDK key forever would starve every later event. (#2456)
- `close()` no longer hangs while the events endpoint is down. It made one attempt per remaining batch in a loop that only ended when the queue emptied. (#2456)

### Changed

- The event queue is now bounded at 10,000 events. It is only reachable during a sustained outage of the events endpoint, where the oldest events are shed first so memory stays bounded and the freshest analytics are kept.
- A batch-size-triggered flush now backs off while the endpoint is failing. A re-queued batch leaves the queue at or above the batch size, so the size trigger would otherwise fire on every recorded event and turn a failing endpoint into one request per evaluation. The periodic flush is the retry vehicle instead.

## 2.6.1 — 2026-08-23

### Fixed

- An unrecognised condition operator now fails closed instead of matching every user. The default arm returned `false`, which a negated condition then inverted to `true` — so a config naming an operator the SDK did not know could silently target everyone. (#2262)
- `identify()` and `track()` put the same payload on the wire as every other server SDK. The field set and shapes had drifted per language, so the same call produced different events depending on which SDK sent it. (#2359)
- Malformed config payloads are validated before they reach the store, so a contract violation leaves the previous config serving rather than replacing it with a broken one. (#2315)

### Changed

- `eventsource` moved to v5, loaded with a dynamic `import()` rather than `require()`. v5 is ESM-only and declares `engines.node >= 22.12`; the dynamic import has no such version cliff, so this package keeps its `engines.node >= 20.19.0` floor. No API change. (#2246)

## 2.6.0 — 2026-08-20

### Fixed

- A closed handle serves the caller's default from every accessor and reports not-initialized. `close()` releases the shared core — stopping streaming and polling, shutting down the event processor — but the in-memory store stayed readable, so a closed client kept evaluating against a frozen snapshot that could never update again while still reporting itself initialized. (#2310)
### Changed

- A type-mismatched read returns the caller's default and reports `'Error'`, instead of handing back the served value as-is. Reading a String flag through a number accessor, say, is now detectable rather than silent. Matching reads and the generic/JSON accessors are unchanged. (#2281)

## 2.5.4 — 2026-08-18

### Fixed

- `require('@featureflip/js')` threw `ERR_INVALID_ARG_VALUE` at module load, so the CommonJS entrypoint was unusable in every release since the first. The Node platform built its module resolver with `createRequire(import.meta.url)`; `import.meta` has no meaning in the CommonJS bundle, so it shipped as `createRequire(undefined)`. It sat at module top level, so no configuration avoided it — `streaming: false` included. ESM consumers were unaffected (#2245).

## 2.5.3 — 2026-08-05

### Fixed

- `LICENSE` is now the verbatim Apache-2.0 text. Three phrases in the operative sections had been reworded and the appendix dropped, which left automated license scanners unable to identify it. The license itself is unchanged; the file now says what it always claimed to.
- The README's License section said MIT. `LICENSE`, `package.json` and the npm listing have always said Apache-2.0, which is the actual license.

## 2.5.2 — 2026-08-02

### Fixed

- The `User-Agent` sent by the Node platform reports the SDK's real version, injected from `package.json` at build time rather than hardcoded. It had been pinned to `0.1.0` since the first release, so every request from a 2.x client identified itself as pre-1.0 (#2141). Browsers forbid setting the header, so the browser platform is unaffected.

## 2.5.1 — 2026-07-30

### Fixed

- **`on('update')` now resolves prerequisites back to their dependents.** Toggling a flag that another flag lists as a prerequisite changes what the dependent evaluates to, but bumps only the prerequisite's own version — so dependents were silently absent from the reported keys, and a consumer caching per key served them stale. Every notification path now fans out transitively through prerequisites: full snapshots (poll and the SSE `sync` event) and the `flag.created`/`flag.updated`/`flag.deleted` deltas alike. Cycle-safe (#2087).
- **Full-snapshot change detection compares configuration, not `version`.** Companion to the delta fix below, on the other update path. The wire version is deliberately second-granular — eval-api divides its internal epoch-millisecond version by 1000 to keep the public contract 32-bit safe for published SDKs — so two edits to one flag inside the same wall-clock second carry an identical version. A full snapshot (poll, SSE `sync`, `segment.updated` refetch) has no per-edit signal to fall back on, so if a snapshot boundary fell between those two edits the newer config landed in the store while `on('update')` reported nothing. `FlagStore.init` now diffs each flag's and segment's serialized configuration, which also covers any field added to a DTO without the comparison having to be extended by hand. Unchanged poll ticks stay silent as before (#2088).
- **A same-version flag delta is no longer discarded.** The store rejected any incoming flag whose version was not strictly greater than the stored one. Because the wire version is second-granular, two edits to one flag inside the same wall-clock second carry an identical version, so the second edit's configuration was dropped — and with streaming enabled (the default) there is no polling snapshot to correct it, leaving evaluations on the pre-edit configuration until an SSE `sync` or reconnect. Only strictly older configurations are now treated as stale (#2090).

## 2.5.0 — 2026-07-29

### Added

- **Flag-update hook.** `client.on('update', keys => …)` fires when flag configuration changes after startup, with the keys of the affected flags batched into one call. Returns an unsubscribe function; `off('update', listener)` also works. Listeners are dropped automatically when the handle that registered them closes. A flag is reported when it is created, deleted, redefined, or when a segment its rules reference changes; the initial load does not fire (#1866).
- **`onEvaluation` inspector callback.** `inspectors` config option registering in-process observers fired on every evaluation, receiving flag key, context, value, variation key, reason, rule id and prerequisite key (#1800).

### Fixed

- A served variation key the flag does not define now reports reason `Error` with the caller's default, instead of a misleading success reason (#1989).
- `prerequisiteKey` is now carried on evaluation analytics events (#1919).
- Non-serializable event metadata is isolated so one poison event can no longer drop a whole analytics batch (#1918).
- The `userId` camelCase alias now resolves on analytics events, so a `userId`-keyed context is no longer left unattributed (#1922).
- Invalid numeric config is rejected, and the event flush is guarded against a non-positive batch size that could spin forever (#1917).

## 2.4.0 — 2026-07-13

### Added

- OpenFeature provider for the Node SDK, published separately as `@featureflip/openfeature-node` (#1227).

### Fixed

- Outage-recovery hardening: initialization is non-terminal, so a failed or timed-out initial fetch serves caller defaults and self-heals rather than hanging, and the SSE `sync` snapshot is applied as a full store replace so flags deleted during a disconnect are dropped (#1863, #1896).

### Changed

- Enforced `tsc --noEmit` typecheck gate added to CI (#1465).
- Cross-SDK golden-vector parity suite (#1477).

## 2.3.0 — 2026-06-19

### Fixed

- Relational operators (numeric, date, semver) match if the attribute satisfies the operator against **any** supplied condition value, matching the engine (#1443).
- `MatchesRegex` is now case-sensitive, matching the engine (#1453).
- Semver prerelease comparison is case-sensitive in ASCII order per semver §11 (#1454).
- `Before`/`After` date operators aligned with the engine: ISO-8601 with offset, unix-seconds fallback, no lexical fallback (#1455).
- Type-aware numeric coercion for `Equals`/`NotEquals`/`In`/`NotIn`, so `1` and `"1.0"` compare equal across every SDK (#1458).
- A keyless/anonymous rollout now serves the control variation deterministically rather than hashing an empty value (#1457).
- A segment-keyed rule with no segment source fails closed instead of matching unconditionally (#1459).
- Environment-level percentage rollouts with no variations no longer throw (#1469).

## 2.2.0 — 2026-06-16

### Added

- Semantic-version condition operators (`SemverEquals`, `SemverGreaterThan`, `SemverGreaterThanOrEqual`, `SemverLessThan`, `SemverLessThanOrEqual`) for local rule evaluation, comparing per semver precedence rather than as decimals (#1409).

## 2.1.0 — 2026-05-27

### Added

- **Prerequisite flag support.** The evaluator resolves prerequisites recursively before applying rules, with a depth cap of 10 and per-call memoization, reporting reason `PrerequisiteFailed` with the failing `prerequisiteKey` (#1028).

### Changed

- Monorepo converted to npm workspaces for the four JS SDKs (#1207).

## 2.0.0 — 2026-04-08

### BREAKING

- **Public `FeatureflipClient` constructor removed.** The only way to obtain a client is now the static factory `FeatureflipClient.get(config, platform)`. The factory dedupes by SDK key: repeated calls with the same key return handles pointing at a single shared underlying client, making DI misregistration, per-request instantiation, and other "multiple clients per process" mistakes harmless instead of leaking SSE connections and background tasks.

  **Migration:**

  Before:
  ```ts
  import { FeatureflipClient, createNodePlatform } from '@featureflip/js';

  const client = new FeatureflipClient(
    { sdkKey: 'your-sdk-key', baseUrl: 'https://eval.featureflip.io' },
    createNodePlatform(),
  );
  ```

  After:
  ```ts
  import { FeatureflipClient, createNodePlatform } from '@featureflip/js';

  const client = FeatureflipClient.get(
    { sdkKey: 'your-sdk-key', baseUrl: 'https://eval.featureflip.io' },
    createNodePlatform(),
  );
  ```

- **`close()` is now refcounted.** When multiple handles share one cached core, closing one handle does not shut down the core — the underlying background tasks and SSE connection stay alive until the last handle is closed. Double-closing the same handle is idempotent and does not double-decrement the refcount. `FeatureflipClient.forTesting(...)` clients are not cached by the factory and are always independent.

- **`platform` is ignored on repeat calls for the same SDK key.** The first `get()` for a given SDK key owns the platform used by the shared core; subsequent `get()` calls with a different platform will log a warning and reuse the cached core's platform. This is intentional — the factory's job is to guarantee one-core-per-key, not to support platform swapping at runtime.

### Added

- `FeatureflipClient.get(config, platform)` — static factory, the new primary entry point.
- Internal `SharedFeatureflipCore` class (`src/core/shared-core.ts`) separating expensive resources (HTTP fetches, event processor, SSE connection, polling timer) from the public handle.
- `FeatureflipClient.debugLiveCoreCount` and `FeatureflipClient.debugRefCount(sdkKey)` internal diagnostics for tests and lifetime debugging.
- `FeatureflipClient.resetForTesting()` internal test helper for clean slate between tests.

### Changed

- `FeatureflipClient` is now a thin handle over `SharedFeatureflipCore`. All evaluation, flush, and close operations delegate to the core.

## 1.0.0

Initial release.
