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

function evaluateOperator(
  operator: ConditionOperator,
  value: string,
  targets: string[],
): boolean {
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
      return targets.some((t) => {
        try {
          return new RegExp(t, 'i').test(value);
        } catch {
          return false;
        }
      });
    case 'GreaterThan':
      return compareNumeric(value, targets[0]!, '>');
    case 'GreaterThanOrEqual':
      return compareNumeric(value, targets[0]!, '>=');
    case 'LessThan':
      return compareNumeric(value, targets[0]!, '<');
    case 'LessThanOrEqual':
      return compareNumeric(value, targets[0]!, '<=');
    case 'Before':
      return value < targets[0]!;
    case 'After':
      return value > targets[0]!;
    default:
      return false;
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

function evaluateCondition(
  condition: ConditionDto,
  context: EvaluationContext,
): boolean {
  const attrValue = getContextAttribute(context, condition.attribute);

  // Missing attribute = fail (unless negated)
  if (attrValue === undefined || attrValue === null) {
    return condition.negate;
  }

  const strValue = String(attrValue).toLowerCase();
  const targets = condition.values.map((v) => v.toLowerCase());

  const result = evaluateOperator(condition.operator, strValue, targets);
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

  const bucket = computeBucket(serve.salt ?? '', bucketValueStr, md5);

  let cumulative = 0;
  for (const wv of serve.variations ?? []) {
    cumulative += wv.weight;
    if (bucket < cumulative) {
      return wv.key;
    }
  }

  // Fallback to last variation
  const variations = serve.variations ?? [];
  return variations.length > 0 ? variations[variations.length - 1]!.key : '';
}

export interface EvaluatorDeps {
  md5: (input: string) => Uint8Array;
  getSegment?: (key: string) => SegmentDto | undefined;
}

/**
 * Evaluate a flag against a context. Pure function, no I/O.
 */
export function evaluate(
  flag: FlagDto,
  context: EvaluationContext,
  deps: EvaluatorDeps,
): EvaluationDetail {
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

  // Step 2: Evaluate rules in priority order
  const sortedRules = [...flag.rules].sort((a, b) => a.priority - b.priority);
  for (const rule of sortedRules) {
    let conditionsMatch: boolean;

    if (rule.segmentKey && deps.getSegment) {
      const segment = deps.getSegment(rule.segmentKey);
      if (segment) {
        conditionsMatch = evaluateConditions(
          segment.conditions,
          segment.conditionLogic,
          context,
        );
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
      return {
        value: variation?.value ?? null,
        variationKey,
        reason: 'RuleMatch',
        ruleId: rule.id,
      };
    }
  }

  // Step 3: No rules matched, use fallthrough
  const variationKey = resolveServe(flag.fallthrough, context, deps.md5);
  const variation = flag.variations.find((v) => v.key === variationKey);
  return {
    value: variation?.value ?? null,
    variationKey,
    reason: 'Fallthrough',
  };
}

// Re-export for testing
export {
  evaluateCondition,
  evaluateConditions,
  evaluateConditionGroups,
  resolveServe,
};
