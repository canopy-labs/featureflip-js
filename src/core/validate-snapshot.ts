import type { FlagDto, GetFlagsResponse, SegmentDto } from './types.js';

/**
 * Raised when a config payload violates the wire contract.
 *
 * Distinct from a network or JSON-syntax failure on purpose: those self-heal on the
 * next poll or reconnect and are correctly silent, while a contract violation means
 * the server and SDK disagree about the shape of the data and must be surfaced. The
 * catch sites key their diagnostics off this type, mirroring ruby's
 * `MalformedPayloadError` (#2285).
 */
export class MalformedPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedPayloadError';
  }
}

/**
 * Assert that every enum-carrying field in a config snapshot arrived as a string.
 *
 * TYPE-ONLY, and that restraint is load-bearing. An *unrecognised* operator string is
 * how a newer server ships a new operator to an older SDK; every evaluator already
 * degrades that to no-match (#2262), so rejecting it here would break this SDK against
 * every future server. What must be rejected is a *type* violation — `0` where `"And"`
 * belongs — because TypeScript's types are erased at runtime and nothing else in the
 * js core would notice: `conditionLogic: 0` fails the `=== 'And'` check and silently
 * flips a segment from ALL of its conditions to ANY of them (#2279, #2315).
 *
 * Unknown *properties* are ignored, for the same forward-compatibility reason.
 *
 * @throws {MalformedPayloadError} on the first violation found.
 */
export function validateSnapshot(data: GetFlagsResponse): void {
  requireArray(data?.flags, 'flags');
  requireArray(data?.segments, 'segments');

  for (const flag of data.flags) validateFlag(flag);
  for (const segment of data.segments) validateSegment(segment);
}

/**
 * The single-flag variant, for the `flag.created` / `flag.updated` delta path. A
 * malformed delta is dropped rather than upserted, which is what "never partially
 * applied" means for a payload whose whole scope is one flag.
 *
 * @throws {MalformedPayloadError}
 */
export function validateFlag(flag: FlagDto): void {
  requireObject(flag, 'flag');
  requireString(flag.type, 'flag.type');
  validateServe(flag.fallthrough, 'flag.fallthrough');

  if (flag.rules !== undefined && flag.rules !== null) {
    requireArray(flag.rules, `flag[${flag.key}].rules`);
    for (const rule of flag.rules) {
      validateServe(rule?.serve, `rule[${rule?.id}].serve`);
      if (rule?.conditionGroups !== undefined && rule.conditionGroups !== null) {
        requireArray(rule.conditionGroups, `rule[${rule.id}].conditionGroups`);
        for (const group of rule.conditionGroups) {
          requireString(group?.operator, `rule[${rule.id}].conditionGroup.operator`);
          validateConditions(group?.conditions, `rule[${rule.id}].conditionGroup`);
        }
      }
    }
  }
}

function validateSegment(segment: SegmentDto): void {
  requireObject(segment, 'segment');
  requireString(segment.conditionLogic, `segment[${segment.key}].conditionLogic`);
  validateConditions(segment.conditions, `segment[${segment.key}]`);
}

function validateServe(serve: unknown, path: string): void {
  // `fallthrough` is required by the contract; a rule's `serve` likewise.
  requireObject(serve, path);
  requireString((serve as { type?: unknown }).type, `${path}.type`);
}

function validateConditions(conditions: unknown, path: string): void {
  if (conditions === undefined || conditions === null) return;
  requireArray(conditions, `${path}.conditions`);
  for (const condition of conditions as Array<{ operator?: unknown }>) {
    requireString(condition?.operator, `${path}.condition.operator`);
  }
}

function requireString(value: unknown, path: string): void {
  if (typeof value !== 'string') {
    throw new MalformedPayloadError(
      `${path} must be a string, got ${describe(value)}`,
    );
  }
}

function requireArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    throw new MalformedPayloadError(
      `${path} must be an array, got ${describe(value)}`,
    );
  }
}

function requireObject(value: unknown, path: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedPayloadError(
      `${path} must be an object, got ${describe(value)}`,
    );
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
