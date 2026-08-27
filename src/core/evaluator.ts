import type {
  ConditionDto,
  ConditionGroupDto,
  ConditionLogic,
  ConditionOperator,
  EvaluationContext,
  EvaluationDetail,
  FlagDto,
  ServeConfigDto,
  SegmentDto,
} from './types.js';

export const MAX_PREREQUISITE_DEPTH = 10;

// DateTimeOffset.MinValue / MaxValue as unix seconds — the exact bounds the
// engine's FromUnixTimeSeconds accepts before throwing (#2432). Kept as literals
// rather than derived from Date, whose own range is ~34,000x wider and would let
// out-of-range values through.
const MIN_UNIX_SECONDS = -62135596800;
const MAX_UNIX_SECONDS = 253402300799;

/**
 * Compute deterministic bucket (0-99) for a value.
 * Uses MD5 hashing for consistency with Python and C# SDKs.
 * Formula: readUInt32LE(md5(salt:value).slice(0, 4)) % 100
 */
export function computeBucket(
  salt: string,
  value: string,
  md5: (input: string) => Uint8Array,
): number {
  const input = `${salt}:${value}`;
  const hashBytes = md5(input);
  // Read first 4 bytes as little-endian unsigned 32-bit integer
  const hashInt =
    (hashBytes[0]!) |
    (hashBytes[1]! << 8) |
    (hashBytes[2]! << 16) |
    ((hashBytes[3]! << 24) >>> 0);
  return (hashInt >>> 0) % 100;
}

function getContextAttribute(
  context: EvaluationContext,
  attribute: string,
): unknown {
  const value = context[attribute];
  if (value !== undefined) return value;
  // Alias "userId" <-> "user_id" for the built-in user identifier
  if (attribute === 'userId') return context['user_id'];
  if (attribute === 'user_id') return context['userId'];
  return undefined;
}

/**
 * Applies a single operator to an already-normalised value/target set.
 *
 * Returns `null` — NOT `false` — for an operator this evaluator does not
 * recognise. The distinction matters: `false` means "evaluated, did not match"
 * and is legitimately inverted by `negate`, whereas `null` means "cannot
 * evaluate" and must never be inverted (see #2262).
 */
function evaluateOperator(
  operator: ConditionOperator,
  value: string,
  targets: string[],
): boolean | null {
  switch (operator) {
    case 'Equals':
      return targets.some((t) => value === t);
    case 'NotEquals':
      return targets.every((t) => value !== t);
    case 'Contains':
      return targets.some((t) => value.includes(t));
    case 'NotContains':
      return targets.every((t) => !value.includes(t));
    case 'StartsWith':
      return targets.some((t) => value.startsWith(t));
    case 'EndsWith':
      return targets.some((t) => value.endsWith(t));
    case 'In':
      return targets.includes(value);
    case 'NotIn':
      return !targets.includes(value);
    case 'MatchesRegex':
      // Case-sensitive (engine uses RegexOptions.None): MatchesRegex is in
      // CASE_SENSITIVE_OPERATORS, so value/targets arrive in original case and
      // the pattern carries no `i` flag. Case-insensitivity is opt-in via (?i).
      //
      // ReDoS note (#1460): the engine bounds catastrophic backtracking with a
      // 100ms regex timeout, but JS `RegExp.test` is synchronous and cannot be
      // interrupted — a true timeout would need a Worker (unavailable in this
      // shared core) or a non-backtracking engine. A pathological config
      // pattern can therefore still be slow here. An invalid pattern throws in
      // the `RegExp` constructor and is caught → no match.
      return targets.some((t) => {
        try {
          return new RegExp(t).test(value);
        } catch {
          return false;
        }
      });
    // Relational operators match if the value satisfies the comparison against
    // ANY supplied condition value (mirrors the server engine + C#/Java SDKs).
    // Empty `values` yields false via `.some` over an empty array.
    case 'GreaterThan':
      return targets.some((t) => compareNumeric(value, t, '>'));
    case 'GreaterThanOrEqual':
      return targets.some((t) => compareNumeric(value, t, '>='));
    case 'LessThan':
      return targets.some((t) => compareNumeric(value, t, '<'));
    case 'LessThanOrEqual':
      return targets.some((t) => compareNumeric(value, t, '<='));
    // Date operators parse both operands as real UTC instants (honoring TZ
    // offsets, assuming UTC when none is given, with a unix-seconds fallback)
    // before comparing — mirroring the engine's CompareDateTime. Unparseable
    // operands contribute no match (never a lexical fallback). Like the
    // relational operators above, match against ANY supplied condition value.
    case 'Before':
      return targets.some((t) => compareDate(value, t, '<'));
    case 'After':
      return targets.some((t) => compareDate(value, t, '>'));
    case 'SemverEquals':
      return targets.some((t) => compareSemver(value, t, '='));
    case 'SemverGreaterThan':
      return targets.some((t) => compareSemver(value, t, '>'));
    case 'SemverGreaterThanOrEqual':
      return targets.some((t) => compareSemver(value, t, '>='));
    case 'SemverLessThan':
      return targets.some((t) => compareSemver(value, t, '<'));
    case 'SemverLessThanOrEqual':
      return targets.some((t) => compareSemver(value, t, '<='));
    default:
      // Unrecognised operator — "cannot evaluate", not "did not match".
      return null;
  }
}

function compareNumeric(
  value: string,
  target: string,
  op: '>' | '<' | '>=' | '<=',
): boolean {
  const val = parseFloat(value);
  const tgt = parseFloat(target);
  if (isNaN(val) || isNaN(tgt)) return false;
  switch (op) {
    case '>':
      return val > tgt;
    case '<':
      return val < tgt;
    case '>=':
      return val >= tgt;
    case '<=':
      return val <= tgt;
  }
}

/**
 * The ONLY characters trimmed from a date operand, and the whole of the operand's
 * permitted whitespace: U+0009..U+000D plus U+0020 — exactly the class the engine's
 * `NumberStyles.Integer` accepts via `AllowLeadingWhite | AllowTrailingWhite`.
 *
 * `String.prototype.trim` is deliberately NOT used: it strips every Unicode
 * whitespace character, so an operand prefixed with U+00A0, U+3000 or U+FEFF was
 * trimmed to `'5'` here and matched, while the engine rejected all three (#2468).
 */
const OPERAND_TRIM = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;

/**
 * Characters no date operand may contain: a NUL or other control character, a
 * non-ASCII whitespace character, or a zero-width no-break space. An interior ASCII
 * space is allowed — it is the ISO-8601 date/time separator.
 *
 * Without this guard the operand reaches `Date.parse`, which resolves `'5\u0000'`
 * and `'5\u001c'` as the calendar date "May 1" in the HOST's timezone — so the same
 * config produced 2001-05-01T04:00Z in New York and 2001-04-30T15:00Z in Tokyo,
 * while the engine read `'5\u0000'` as five seconds past the epoch and rejected
 * `'5\u001c'`. That is the same timezone-dependent failure #2432 fixed for bare
 * integers, and in a browser it means different flag values per user timezone
 * (#2468). (This package, via its `browser` export condition — `@featureflip/browser`
 * evaluates server-side and never runs this code.)
 */
const FORBIDDEN_OPERAND_CHAR =
  /[\u0000-\u001f\u007f-\u009f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/**
 * The ISO-8601 grammar a date operand may use: a calendar date, optionally followed by
 * a time (seconds and fractional seconds optional) and an optional offset in either
 * extended (`+05:00` / `Z`) or basic (`+0500`) form. The separator may be `T` or a
 * space — the engine accepts both.
 *
 * Byte-for-byte the grammar go/python/ruby/php/java pin. It is pinned HERE rather than
 * delegated to `Date.parse` because `Date.parse` is specified to fall back to an
 * implementation-defined parser for anything outside the ECMAScript Date Time String
 * Format, and V8's accepts `05/15/2023`, `Jan 1 2024` and `2024.01.01` — resolving each
 * in the HOST's timezone, since the UTC-by-default rule only covers the specified ISO
 * shapes. One saved rule therefore evaluated to a different instant per host, which in
 * a browser is a different flag value per user timezone (#2480). Same failure
 * class as #2432 and #2468; these operands survived both because they carry no
 * forbidden character and are not entirely digits.
 */
const ISO_OPERAND =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Length of each month in a non-leap year, indexed 1..12. Index 0 is unused padding. */
const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Whether `date` — always `YYYY-MM-DD`, since only `canonicalizeIso` calls this —
 * names a day that exists.
 *
 * `ISO_OPERAND` matches the SHAPE of a calendar date and a character class cannot
 * express "is a real day", so `2024-02-30`, `2023-02-29` and `2024-04-31` all pass the
 * grammar. The engine, csharp, go, python and java then reject them at parse; js, ruby
 * and php ROLLED THEM OVER into the 1st of the following month, so one saved rule
 * served different variations to two users purely by which SDK their service ran
 * (#2491).
 *
 * The arithmetic is hand-rolled rather than delegated to a platform validator, because
 * the platforms do not agree on what a valid date is: ruby's `Date.valid_date?` applies
 * the Italian calendar reform by default and rejects 1582-10-05..14, which the engine
 * resolves normally. Computing it identically in js, ruby and php is what keeps the
 * accepted set a property of THIS contract rather than of three separate calendars.
 *
 * Proleptic Gregorian, matching the engine: the leap rule is applied uniformly at every
 * year rather than from a reform date onward.
 */
function isRealCalendarDay(date: string): boolean {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));

  // Month 0 and day 0 are the shapes only php mishandled, rolling each BACKWARDS into
  // the previous year (`2024-00-01` -> 2023-12-01, `2024-01-00` -> 2023-12-31).
  if (month < 1 || month > 12 || day < 1) return false;

  const leapDay =
    month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 1 : 0;
  return day <= DAYS_IN_MONTH[month]! + leapDay;
}

/**
 * Rewrites an accepted ISO operand into the one shape the ECMAScript Date Time String
 * Format specifies — `T` separator, seconds present, at most three fractional digits,
 * an explicit offset — or returns null when `s` is not an accepted ISO shape.
 *
 * Canonicalizing is what makes the accepted set independent of V8's leniency AND of the
 * host timezone: every string handed to `Date.parse` carries an explicit offset, so
 * `Date.parse` never gets to apply its local-time default. An offset-less operand is
 * given `Z`, mirroring the engine's `AssumeUniversal`.
 */
function canonicalizeIso(s: string): string | null {
  const m = ISO_OPERAND.exec(s);
  if (m === null) return null;

  const [, date, hh, mm, ss, frac, off] = m;

  // Checked on the WRITTEN date, before any offset is applied. Validating the resolved
  // UTC components instead would accept `2024-02-30T00:00:00+05:00`, which lands on
  // 2024-02-29T19:00Z — a date that does exist.
  if (!isRealCalendarDay(date!)) return null;

  if (hh === undefined) return `${date}T00:00:00Z`;

  // The engine's DateTimeOffset.TryParse rejects hour 24 outright rather than rolling
  // it over to 00:00 the next day, which is what `Date.parse` does — so
  // `2024-01-01T24:00:00` silently became 2024-01-02 here (and in python/ruby/php)
  // against no-match everywhere else (#2468). A string compare covers 25..99 too.
  if (hh >= '24') return null;

  // The Date Time String Format specifies EXACTLY three fractional digits, so `.5` and
  // `.12` are as non-conforming as `.123456789` — and a non-conforming string is
  // precisely what ES sends to the implementation-defined parser this function exists to
  // stay out of. Right-pad to three and truncate beyond, which makes every canonical
  // string conforming and so keeps the timezone-independence structural rather than
  // V8-observed (this ships a `browser` export condition, so JSC and SpiderMonkey run it
  // too). Value-neutral: `.1` and `.100` are the same 100ms, here and in the five SDKs.
  const fraction = frac ? `${frac}000`.slice(0, 4) : '';

  // Offset-less -> UTC. Basic offset (+0500) -> extended (+05:00), the only form the
  // Date Time String Format specifies.
  let offset = off ?? 'Z';
  if (offset.length === 5) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;

  return `${date}T${hh}:${mm}:${ss ?? '00'}${fraction}${offset}`;
}

/**
 * Parses a date-time operand to epoch milliseconds (UTC), or null when it can't
 * be parsed. Mirrors the evaluation service's `TryParseDateTime`:
 *
 * 1. A bare integer is Unix time in seconds since the epoch, resolved BEFORE any
 *    date parse. The order is load-bearing (#2432) — see below.
 * 2. Otherwise an ISO-8601 date-time matching `ISO_OPERAND`. A timezone designator
 *    (`Z` or `+05:00`) is honored; with none the value is interpreted as UTC.
 * 3. Anything else fails (returns null) — never a lexical fallback.
 *
 * The accepted grammar is PINNED by `ISO_OPERAND` rather than delegated to
 * `Date.parse`, which accepts far more (`05/15/2023`, `Jan 1 2024`) and resolves all
 * of it in the host's timezone (#2480). Step 2 is where js previously diverged from
 * go/java/python/ruby/php, which have always gated their date branch on this grammar.
 *
 * `Before`/`After` are in CASE_SENSITIVE_OPERATORS, so operands reach here with
 * their original case — the ISO `T`/`Z` designators are intact rather than
 * lowercased upstream.
 *
 * KNOWN ENGINE DIVERGENCE (#2480): the engine's `DateTimeOffset.TryParse` with the
 * invariant culture still accepts the non-ISO forms this rejects, resolving them at
 * UTC midnight. Narrowing the engine would stop an operand that evaluates today from
 * evaluating at all, for rules customers may already have saved — a data-migration
 * decision, tracked separately. The C# SDK makes the identical `DateTimeOffset.TryParse`
 * call and pins no grammar, so it shares that leniency; this moves js off that side and
 * onto the five, rather than leaving it a third camp of one — which is what it was,
 * being the only implementation whose answer also depended on the host's timezone.
 * Management rejects these operands on WRITE (`PortableDateOperand`), so the gap
 * narrows going forward without changing how a saved rule evaluates.
 *
 * KNOWN PLATFORM FLOOR (#2468): the return value is epoch MILLISECONDS, because
 * that is all `Date` represents. The engine keeps 100ns ticks, so an operand with
 * more than three fractional digits resolves here to a slightly earlier instant —
 * `…T00:00:00.123456Z` is `.123` here and `.123456` in the engine. This is the one
 * date divergence left after #2468 and it is not fixable without abandoning `Date`:
 * a double has ~200ns of resolution at present-day epoch millis, so carrying the
 * extra digits as a fraction would trade one inexactness for another. It can only
 * change an outcome when two operands differ by under a millisecond, so the golden
 * vectors deliberately stay at millisecond granularity rather than encoding an
 * expectation js cannot meet.
 */
function parseDateTime(s: string): number | null {
  const trimmed = s.replace(OPERAND_TRIM, '');

  if (trimmed.length === 0 || FORBIDDEN_OPERAND_CHAR.test(trimmed)) {
    return null;
  }

  // A bare integer is Unix time in SECONDS, and is resolved BEFORE any date
  // parse. The order is load-bearing (#2432).
  //
  // The engine reads as `TryParse` first, unix second, and this used to mirror
  // that literally — but the two halves are not equivalent, because
  // `DateTimeOffset.TryParse` REJECTS every pure-numeric string while JS's
  // `Date.parse` accepts one as a YEAR. So the engine always reached its unix
  // fallback and js almost never did: `"2024"` became 2024-01-01 here and
  // 1970-01-01T00:33:44Z everywhere else, and `"0"` became the year 2000. Worse,
  // a year parsed from a non-ISO form is resolved in LOCAL time, so the same
  // config produced different instants on different hosts — in a browser, different
  // flag values for users in different timezones.
  //
  // Checking the integer first is what makes the two agree, since no string that
  // is entirely digits is a date to the engine. The sign class matches
  // `long.TryParse` with `NumberStyles.Integer`, which accepts a leading `+`.
  if (/^[+-]?\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    // Out of range matches NOTHING rather than clamping or wrapping: the
    // engine's `FromUnixTimeSeconds` throws outside DateTimeOffset's range and
    // `TryParseDateTime` returns false. The case that matters in practice is a
    // MILLISECONDS timestamp pasted where seconds belong — `Date.now()` is the
    // obvious way to produce one — which would otherwise silently become an
    // instant in the year 55829 and satisfy every `After` comparison.
    if (
      !Number.isFinite(seconds) ||
      seconds < MIN_UNIX_SECONDS ||
      seconds > MAX_UNIX_SECONDS
    ) {
      return null;
    }
    return seconds * 1000;
  }

  // The ISO branch parses a CANONICALIZED string, never the raw operand. Handing the
  // operand straight to `Date.parse` is what let non-ISO forms through to V8's
  // implementation-defined parser, and with them the host-timezone dependence
  // `canonicalizeIso` now makes structurally impossible.
  const canonical = canonicalizeIso(trimmed);
  if (canonical === null) {
    return null;
  }

  // An unreal day is already gone (`isRealCalendarDay`), so this is NaN only for the
  // out-of-range minute and second the grammar's `\d{2}` still admits — `00:99` and
  // `00:00:99`, which every other SDK rejects too.
  const ms = Date.parse(canonical);
  if (Number.isNaN(ms)) return null;

  // The SAME range the integer branch above enforces, applied to the RESOLVED instant.
  //
  // The engine's parse is `DateTimeOffset.TryParse`, so its accepted set is bounded by
  // `DateTimeOffset`'s range — 0001-01-01T00:00:00Z to 9999-12-31T23:59:59.9999999Z —
  // and it returns false outside it. js, ruby, php, go and java all resolve past both
  // ends instead: year 0 to a real instant, and a 4-digit year plus an offset to one
  // beyond either bound (#2500).
  //
  // Checked on the RESOLVED instant, deliberately unlike the WRITTEN-triple check in
  // `isRealCalendarDay`. The two look contradictory and are answering different
  // questions: whether the operand names a real DAY is a property of what was written
  // (`2024-02-30T00:00:00+05:00` lands on a real UTC day but names none), whereas
  // whether it is REPRESENTABLE is a property of what it resolves to — the offset is
  // exactly what carries `0001-01-01T00:00:00+05:00` under the floor and
  // `9999-12-31T23:59:59-05:00` over the ceiling, from a year the grammar allows.
  //
  // Flooring matches every other SDK: a fractional second is always a non-negative
  // addend, so `0000-12-31T23:59:59.5Z` floors to MIN-1 and is rejected, while
  // `0001-01-01T00:00:00.5Z` floors to MIN and is kept.
  const seconds = Math.floor(ms / 1000);
  if (seconds < MIN_UNIX_SECONDS || seconds > MAX_UNIX_SECONDS) return null;
  return ms;
}

function compareDate(
  value: string,
  target: string,
  op: '>' | '<',
): boolean {
  const val = parseDateTime(value);
  const tgt = parseDateTime(target);
  if (val === null || tgt === null) return false;
  return op === '>' ? val > tgt : val < tgt;
}

/**
 * Compares two semantic-version strings (https://semver.org) for the `Semver*` operators.
 *
 * Tolerant of real-world version strings: an optional leading `v`, an arbitrary number of
 * dot-separated numeric segments (missing trailing segments compare as 0, so `2.0` == `2.0.0`),
 * an optional `-prerelease` suffix (lower precedence than the release), and `+build` metadata
 * (ignored for precedence). Numeric segments are compared digit-by-digit, so arbitrarily large
 * version numbers never overflow. An unparseable version matches nothing.
 *
 * Mirrors the evaluation service's `SemverComparer` so server-side and SDK-local evaluation agree.
 */
interface SemverParts {
  release: string[];
  prerelease: string[];
}

function isAllDigits(s: string): boolean {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

function parseSemver(value: string | undefined): SemverParts | null {
  if (value === undefined) return null;
  let s = value.trim();
  if (s.length === 0) return null;

  // Optional leading "v".
  if (s[0] === 'v' || s[0] === 'V') s = s.slice(1);

  // Build metadata ("+...") does not affect precedence.
  const plus = s.indexOf('+');
  if (plus >= 0) s = s.slice(0, plus);

  // Split the release core from the optional "-prerelease" suffix.
  let core: string;
  let prerelease: string[];
  const dash = s.indexOf('-');
  if (dash >= 0) {
    core = s.slice(0, dash);
    const pre = s.slice(dash + 1);
    if (pre.length === 0) return null;
    prerelease = pre.split('.');
    if (prerelease.some((id) => id.length === 0)) return null;
  } else {
    core = s;
    prerelease = [];
  }

  if (core.length === 0) return null;
  const release = core.split('.');
  if (release.some((seg) => !isAllDigits(seg))) return null;

  return { release, prerelease };
}

/**
 * Compares two all-digit strings as non-negative integers without parsing (overflow-free):
 * strip leading zeros, then the longer string is the larger number; equal lengths compare
 * lexically.
 */
function compareNumericString(a: string, b: string): number {
  a = a.replace(/^0+/, '');
  b = b.replace(/^0+/, '');
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrereleaseId(a: string, b: string): number {
  const aNum = isAllDigits(a);
  const bNum = isAllDigits(b);
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNum && bNum) return compareNumericString(a, b);
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a: string[], b: string[]): number {
  // A version with no prerelease has higher precedence than one with a prerelease.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) {
    const cmp = comparePrereleaseId(a[i]!, b[i]!);
    if (cmp !== 0) return cmp;
  }
  // All shared identifiers equal: the longer prerelease has higher precedence.
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function compareSemverParts(a: SemverParts, b: SemverParts): number {
  const max = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < max; i++) {
    const segA = i < a.release.length ? a.release[i]! : '0';
    const segB = i < b.release.length ? b.release[i]! : '0';
    const cmp = compareNumericString(segA, segB);
    if (cmp !== 0) return cmp;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function compareSemver(
  value: string,
  target: string | undefined,
  op: '>' | '<' | '>=' | '<=' | '=',
): boolean {
  const left = parseSemver(value);
  const right = parseSemver(target);
  if (left === null || right === null) return false;
  const c = compareSemverParts(left, right);
  switch (op) {
    case '>':
      return c > 0;
    case '<':
      return c < 0;
    case '>=':
      return c >= 0;
    case '<=':
      return c <= 0;
    case '=':
      return c === 0;
  }
}

// Operators that must receive the original-case operands instead of the
// up-front-folded lowercase ones. Semver compares prerelease identifiers
// case-sensitively (semver §11, ASCII order) — folding would flip precedence vs
// the engine's SemverComparer (#1454). MatchesRegex matches case-sensitively
// (the engine uses RegexOptions.None) (#1453). Date Before/After parse ISO-8601,
// whose `T`/`Z` designators are case-sensitive — folding would break parsing
// (#1455). Every other operator here matches case-insensitively, so casing is
// folded up front only for those.
const CASE_SENSITIVE_OPERATORS: ReadonlySet<ConditionOperator> = new Set([
  'SemverEquals',
  'SemverGreaterThan',
  'SemverGreaterThanOrEqual',
  'SemverLessThan',
  'SemverLessThanOrEqual',
  'MatchesRegex',
  'Before',
  'After',
]);

// Equality-family operators that compare numerically when the raw attribute is
// a number (#1458). Mirrors the .NET engine: only these coerce — never
// Contains/StartsWith/EndsWith, which stay string-based.
const NUMERIC_EQUALITY_OPERATORS: ReadonlySet<ConditionOperator> = new Set([
  'Equals',
  'NotEquals',
  'In',
  'NotIn',
]);

// Strictly parse a condition literal as a finite number for the numeric
// equality path. Uses Number() (NOT parseFloat) so partial parses fail —
// parseFloat("1abc") === 1 (lenient) but we need "1" Equals "1abc" to be FALSE.
// Number('') === 0, so empty/whitespace strings are rejected up front. Returns
// null for anything non-finite (NaN, Infinity, "1abc"). Note: Number('0x10')
// === 16 is an accepted hex edge — fine, the engine's double.Parse rejects it,
// but this is an extreme edge with no practical flag-targeting impact.
function parseNumericStrict(s: string): number | null {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function evaluateCondition(
  condition: ConditionDto,
  context: EvaluationContext,
): boolean {
  const attrValue = getContextAttribute(context, condition.attribute);

  // Missing attribute = fail (unless negated)
  if (attrValue === undefined || attrValue === null) {
    return condition.negate;
  }

  // Type-aware numeric equality (#1458): when the raw attribute is a finite
  // number (booleans are typeof 'boolean', so naturally excluded) and the
  // operator is an equality-family op, compare numerically BEFORE stringifying.
  // This makes `1 Equals "1.0"` true and `1 Equals "1abc"` false, matching the
  // engine. All other operators / attribute types fall through to the string
  // path below unchanged.
  if (
    typeof attrValue === 'number' &&
    Number.isFinite(attrValue) &&
    NUMERIC_EQUALITY_OPERATORS.has(condition.operator)
  ) {
    const anyEqual = condition.values.some((v) => {
      const n = parseNumericStrict(v);
      return n !== null && n === attrValue;
    });
    const positive =
      condition.operator === 'Equals' || condition.operator === 'In';
    const result = positive ? anyEqual : !anyEqual;
    return condition.negate ? !result : result;
  }

  const caseSensitive = CASE_SENSITIVE_OPERATORS.has(condition.operator);
  const rawValue = String(attrValue);
  const strValue = caseSensitive ? rawValue : rawValue.toLowerCase();
  const targets = caseSensitive
    ? condition.values
    : condition.values.map((v) => v.toLowerCase());

  const result = evaluateOperator(condition.operator, strValue, targets);

  // Issue #2262: an unrecognised operator fails CLOSED. Letting `negate` invert
  // it would turn "I cannot evaluate this" into "matches every user" — a flag
  // silently rolled out to 100% of traffic. The realistic trigger is a new
  // operator shipped server-side reaching an SDK pinned to an older version.
  if (result === null) return false;

  return condition.negate ? !result : result;
}

function evaluateConditions(
  conditions: ConditionDto[],
  logic: ConditionLogic,
  context: EvaluationContext,
): boolean {
  if (conditions.length === 0) return true;

  if (logic === 'And') {
    return conditions.every((c) => evaluateCondition(c, context));
  }
  return conditions.some((c) => evaluateCondition(c, context));
}

function evaluateConditionGroups(
  groups: ConditionGroupDto[],
  context: EvaluationContext,
): boolean {
  if (groups.length === 0) return true;

  // All groups must match (AND between groups)
  return groups.every((group) =>
    evaluateConditions(group.conditions, group.operator, context),
  );
}

function resolveServe(
  serve: ServeConfigDto,
  context: EvaluationContext,
  md5: (input: string) => Uint8Array,
): string {
  if (serve.type === 'Fixed') {
    return serve.variation ?? '';
  }

  // Rollout
  const bucketBy = serve.bucketBy ?? 'userId';
  const bucketValue = getContextAttribute(context, bucketBy);
  const bucketValueStr = bucketValue != null ? String(bucketValue) : '';
  const variations = serve.variations ?? [];

  // A Rollout serve can arrive with no weighted variations — env-level PercentageRollout
  // has nowhere to store per-variation weights, so the mapper emits Type=Rollout with no
  // variations (#1469). Degrade to the default fixed variation instead of returning an
  // empty key. Mirrors the engine + C#/Java SDK evaluators.
  if (variations.length === 0) {
    return serve.variation ?? '';
  }

  // Keyless user contexts can't be bucketed. Rather than hashing the empty
  // value into an arbitrary salt-dependent bucket, serve the control (first)
  // variation deterministically. The engine assigns a random GUID per eval
  // (spreading anonymous users over HTTP); local SDK eval is deterministic, so
  // parity is guaranteed only for keyed contexts (#1457).
  if (
    bucketValueStr === '' &&
    (bucketBy === 'userId' || bucketBy === 'user_id') &&
    variations.length > 0
  ) {
    return variations[0]!.key;
  }

  const bucket = computeBucket(serve.salt ?? '', bucketValueStr, md5);

  let cumulative = 0;
  for (const wv of variations) {
    cumulative += wv.weight;
    if (bucket < cumulative) {
      return wv.key;
    }
  }

  // Fallback to last variation (variations is guaranteed non-empty — the no-variations
  // case returned the default above).
  return variations[variations.length - 1]!.key;
}

export interface EvaluatorDeps {
  md5: (input: string) => Uint8Array;
  getSegment?: (key: string) => SegmentDto | undefined;
}

/**
 * Evaluate a flag against a context. Pure function, no I/O.
 *
 * @param flag      The flag to evaluate.
 * @param context   The evaluation context.
 * @param deps      Evaluator dependencies (md5, getSegment).
 * @param allFlags  Map of all flags in the environment, keyed by flag key.
 *                  Required for prerequisite resolution; pass `{}` if the flag
 *                  has no prerequisites.
 */
export function evaluate(
  flag: FlagDto,
  context: EvaluationContext,
  deps: EvaluatorDeps,
  allFlags: Record<string, FlagDto> = {},
): EvaluationDetail {
  const memo = new Map<string, EvaluationDetail>();
  return evaluateInternal(flag, context, deps, allFlags, 0, memo);
}

/**
 * Evaluate a flag, sharing a memoisation map with other concurrent
 * evaluations (e.g. a batch "evaluate all" pass).
 *
 * Use this when evaluating multiple flags in one sweep so that shared
 * prerequisite flags are only evaluated once.
 */
export function evaluateWithSharedMemo(
  flag: FlagDto,
  context: EvaluationContext,
  deps: EvaluatorDeps,
  allFlags: Record<string, FlagDto>,
  memo: Map<string, EvaluationDetail>,
): EvaluationDetail {
  return evaluateInternal(flag, context, deps, allFlags, 0, memo);
}

function evaluateInternal(
  flag: FlagDto,
  context: EvaluationContext,
  deps: EvaluatorDeps,
  allFlags: Record<string, FlagDto>,
  depth: number,
  memo: Map<string, EvaluationDetail>,
): EvaluationDetail {
  // Guard: prevent runaway recursion (shouldn't happen with cycle detection at
  // write time, but depth-limit as a safety net).
  if (depth > MAX_PREREQUISITE_DEPTH) {
    const offVariation = flag.variations.find((v) => v.key === flag.offVariation);
    return {
      value: offVariation?.value ?? null,
      variationKey: flag.offVariation,
      reason: 'Error',
    };
  }

  // Step 1: Check if flag is disabled
  if (!flag.enabled) {
    const variation = flag.variations.find(
      (v) => v.key === flag.offVariation,
    );
    return {
      value: variation?.value ?? null,
      variationKey: flag.offVariation,
      reason: 'FlagDisabled',
    };
  }

  // Step 2: Resolve prerequisites
  for (const prereq of flag.prerequisites ?? []) {
    // Check memo first to avoid re-evaluating the same flag twice in one sweep
    let prereqResult = memo.get(prereq.prerequisiteFlagKey);

    if (!prereqResult) {
      const prereqFlag = allFlags[prereq.prerequisiteFlagKey];

      if (!prereqFlag) {
        // Missing flag: fail safely
        const offVariation = flag.variations.find((v) => v.key === flag.offVariation);
        const result: EvaluationDetail = {
          value: offVariation?.value ?? null,
          variationKey: flag.offVariation,
          reason: 'PrerequisiteFailed',
          prerequisiteKey: prereq.prerequisiteFlagKey,
        };
        memo.set(flag.key, result);
        return result;
      }

      prereqResult = evaluateInternal(prereqFlag, context, deps, allFlags, depth + 1, memo);
      memo.set(prereq.prerequisiteFlagKey, prereqResult);
    }

    // Bubble up errors from recursive evaluation
    if (prereqResult.reason === 'Error') {
      const offVariation = flag.variations.find((v) => v.key === flag.offVariation);
      const result: EvaluationDetail = {
        value: offVariation?.value ?? null,
        variationKey: flag.offVariation,
        reason: 'Error',
      };
      memo.set(flag.key, result);
      return result;
    }

    // Check that the prerequisite served the expected variation
    if (prereqResult.variationKey !== prereq.expectedVariationKey) {
      const offVariation = flag.variations.find((v) => v.key === flag.offVariation);
      const result: EvaluationDetail = {
        value: offVariation?.value ?? null,
        variationKey: flag.offVariation,
        reason: 'PrerequisiteFailed',
        prerequisiteKey: prereq.prerequisiteFlagKey,
      };
      memo.set(flag.key, result);
      return result;
    }
  }

  // Step 3: Evaluate rules in priority order
  const sortedRules = [...flag.rules].sort((a, b) => a.priority - b.priority);
  for (const rule of sortedRules) {
    let conditionsMatch: boolean;

    if (rule.segmentKey) {
      // A segment-keyed rule must resolve its segment to match. If the segment
      // source isn't wired, or the segment can't be found, fail closed (no
      // match) — mirroring the engine + C# SDK — rather than falling through to
      // the rule's condition groups (which would match unconditionally when
      // empty).
      if (deps.getSegment) {
        const segment = deps.getSegment(rule.segmentKey);
        conditionsMatch = segment
          ? evaluateConditions(
              segment.conditions,
              segment.conditionLogic,
              context,
            )
          : false;
      } else {
        conditionsMatch = false;
      }
    } else {
      conditionsMatch = evaluateConditionGroups(
        rule.conditionGroups,
        context,
      );
    }

    if (conditionsMatch) {
      const variationKey = resolveServe(rule.serve, context, deps.md5);
      const variation = flag.variations.find((v) => v.key === variationKey);
      const result: EvaluationDetail = {
        value: variation?.value ?? null,
        variationKey,
        reason: 'RuleMatch',
        ruleId: rule.id,
      };
      memo.set(flag.key, result);
      return result;
    }
  }

  // Step 4: No rules matched, use fallthrough
  const variationKey = resolveServe(flag.fallthrough, context, deps.md5);
  const variation = flag.variations.find((v) => v.key === variationKey);
  const result: EvaluationDetail = {
    value: variation?.value ?? null,
    variationKey,
    reason: 'Fallthrough',
  };
  memo.set(flag.key, result);
  return result;
}

// Re-export for testing
export {
  evaluateCondition,
  evaluateConditions,
  evaluateConditionGroups,
  resolveServe,
};
