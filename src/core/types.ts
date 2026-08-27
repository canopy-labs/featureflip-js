// Flag types matching Evaluation API contracts

export type FlagType = 'Boolean' | 'String' | 'Number' | 'Json';
export type ServeType = 'Fixed' | 'Rollout';
export type ConditionLogic = 'And' | 'Or';
export type SdkEventType = 'Evaluation' | 'Impression' | 'Identify' | 'Custom';
export type EvaluationReason =
  | 'RuleMatch'
  | 'Fallthrough'
  | 'FlagDisabled'
  | 'FlagNotFound'
  | 'PrerequisiteFailed'
  | 'Error';

export type ConditionOperator =
  | 'Equals'
  | 'NotEquals'
  | 'In'
  | 'NotIn'
  | 'Contains'
  | 'NotContains'
  | 'StartsWith'
  | 'EndsWith'
  | 'MatchesRegex'
  | 'GreaterThan'
  | 'GreaterThanOrEqual'
  | 'LessThan'
  | 'LessThanOrEqual'
  | 'Before'
  | 'After'
  | 'SemverEquals'
  | 'SemverGreaterThan'
  | 'SemverGreaterThanOrEqual'
  | 'SemverLessThan'
  | 'SemverLessThanOrEqual';

export interface VariationDto {
  key: string;
  value: unknown;
}

export interface ConditionDto {
  attribute: string;
  operator: ConditionOperator;
  values: string[];
  negate: boolean;
}

export interface WeightedVariationDto {
  key: string;
  weight: number;
}

export interface ServeConfigDto {
  type: ServeType;
  variation?: string;
  bucketBy?: string;
  salt?: string;
  variations?: WeightedVariationDto[];
}

export interface ConditionGroupDto {
  operator: ConditionLogic;
  conditions: ConditionDto[];
}

export interface RuleDto {
  id: string;
  priority: number;
  conditionGroups: ConditionGroupDto[];
  serve: ServeConfigDto;
  segmentKey?: string;
}

export interface Prerequisite {
  prerequisiteFlagKey: string;
  expectedVariationKey: string;
}

export interface FlagDto {
  key: string;
  version: number;
  type: FlagType;
  enabled: boolean;
  variations: VariationDto[];
  rules: RuleDto[];
  fallthrough: ServeConfigDto;
  offVariation: string;
  prerequisites?: Prerequisite[];
}

export interface SegmentDto {
  key: string;
  version: number;
  conditions: ConditionDto[];
  conditionLogic: ConditionLogic;
}

export interface GetFlagsResponse {
  environment: string;
  version: number;
  flags: FlagDto[];
  segments: SegmentDto[];
}

export interface EvaluationDetail<T = unknown> {
  value: T;
  variationKey?: string;
  reason: EvaluationReason;
  ruleId?: string;
  prerequisiteKey?: string;
}

export type EvaluationContext = Record<string, unknown>;

/**
 * The object passed to each registered evaluation inspector. Fired once per
 * variation call, synchronously, during evaluation. `context` is a shallow copy
 * of the caller's context — treat it as read-only. Optional fields are set only
 * for their corresponding reason (`ruleId` on `RuleMatch`, `prerequisiteKey` on
 * `PrerequisiteFailed`).
 */
export interface EvaluationEvent {
  flagKey: string;
  context: EvaluationContext;
  value: unknown;
  variationKey?: string;
  reason: EvaluationReason;
  ruleId?: string;
  prerequisiteKey?: string;
  timestamp: string;
}

/** An in-process observer invoked on every flag evaluation. Return value ignored. */
export type EvaluationInspector = (event: EvaluationEvent) => void;

/** Events a client can be subscribed to via `on`/`off`. */
export type FeatureflipEvent = 'update';

/**
 * Called when flag configuration changes after the initial load, with the keys
 * of the affected flags. Batched: one call per update, however many flags it
 * touched. Never called with an empty array, and never for the initial load.
 *
 * A flag is reported when it is added, removed, its definition changed, or a
 * segment its rules reference changed. Return value ignored.
 */
export type FlagUpdateListener = (keys: string[]) => void;

export interface SdkEventDto {
  type: SdkEventType;
  flagKey: string;
  userId?: string;
  variation?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  // Set on `Evaluation` events that resolved `PrerequisiteFailed`, so analytics
  // can attribute the gating prerequisite. Mirrors the backend `SdkEventDto`
  // (`PrerequisiteKey`); omitted (not null) on the wire when absent.
  prerequisiteKey?: string;
}

export interface RecordEventsRequest {
  events: SdkEventDto[];
}

export interface StreamFlagUpdatedEvent {
  key: string;
  version: number;
}

export interface StreamPingEvent {
  timestamp: string;
}
