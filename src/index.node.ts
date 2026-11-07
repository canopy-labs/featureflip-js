export { FeatureflipClient } from './client.js';
export { createNodePlatform } from './platform/node.js';
export type { FeatureflipConfig } from './config.js';
export type {
  EvaluationContext,
  EvaluationDetail,
  EvaluationEvent,
  EvaluationInspector,
  EvaluationReason,
  FeatureflipEvent,
  FlagType,
  FlagUpdateListener,
} from './core/types.js';
export { FileSnapshotStore } from './platform/file-snapshot-store.js';
export type { StartupInfo } from './core/shared-core.js';
export type { SnapshotStore } from './core/snapshot-store.js';
export type { Platform } from './platform/types.js';
