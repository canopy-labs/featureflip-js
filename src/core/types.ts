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
  | 'After';

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

export interface FlagDto {
  key: string;
  version: number;
  type: FlagType;
  enabled: boolean;
  variations: VariationDto[];
  rules: RuleDto[];
  fallthrough: ServeConfigDto;
  offVariation: string;
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
}

export type EvaluationContext = Record<string, unknown>;

export interface SdkEventDto {
  type: SdkEventType;
  flagKey: string;
  userId?: string;
  variation?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
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
