// Config
export { loadConfigFromFile, loadAuthToken } from './config/load.js';
export { collectInlineApiKeyOffenders } from './config/config-resolver.js';
export { parseConfig, multiModelConfigSchema, serverConfigSchema } from './config/schema.js';
export type { ServerConfig } from './config/schema.js';

// Types (re-export all)
export type {
  ToolMode,
  SandboxPolicy,
  AgentType,
  AgentConfig,
  Effort,
  CostTier,
  TaskSpec,
  ProviderConfig,
  CodexProviderConfig,
  ClaudeProviderConfig,
  MultiModelConfig,
  RunResult,
  RuntimeRunResult,
  Provider,
} from './types.js';
export type {
  RunStatus,
  TokenUsage,
  RunOptions,
  ProgressEvent,
  InternalRunnerEvent,
} from './providers/runner-types.js';
export type {
  BatchTimings,
  BatchProgress,
  BatchAggregateCost,
} from './lifecycle/executor-output-types.js';
// (EligibilityFailure / ProviderEligibility re-exports removed —
//  escalation/types.js is being deleted along with the rest of escalation/.)
export type {
  BriefQualityPolicy,
} from './types/brief-quality-policy.js';
export { ParsedStructuredReport } from './reporting/structured-report.js';
export { notApplicableSchema, notApplicable, isNotApplicable, type NotApplicable } from './reporting/not-applicable.js';
export { composeRunningHeadline, type RunningState, type RunningTask } from './reporting/compose-running-headline.js';
export { composeTerminalHeadline, type TerminalHeadlineInput } from './reporting/compose-terminal-headline.js';
export { TerminalStatusDeriver, type WorkerStatus, type OverallReviewVerdict, type ArtifactsCheck, type TerminalStatus, type TerminalInputs, type TerminalDecision } from './reporting/terminal-status-deriver.js';
export {
  FINDINGS_OUTCOME_KINDS,
  findingsOutcomeKindSchema,
  inferFromFindings,
  aggregateOutcomes,
  type FindingsOutcomeKind,
} from './reporting/findings-outcome.js';

// Context blocks
export {
  InMemoryContextBlockStore,
  ContextBlockNotFoundError,
} from './stores/context-block-tool.js';
export type {
  ContextBlockStore,
  RegisteredBlock,
  InMemoryContextBlockStoreOptions,
} from './stores/context-block-tool.js';
export { expandContextBlocks } from './stores/expand-context-blocks.js';

// Provider
export { createProvider, __setCoreTestProviderOverride, __setCoreTestProviderOverrideMap } from './providers/provider-factory.js';

// Batch cache
export { BatchCache } from './stores/batch-cache.js';
export type { BatchEntry, BatchEntryStatus, BatchCacheOptions } from './stores/batch-cache.js';

// Project context
export { createProjectContext, createInMemoryProjectContext } from './stores/project-context-registry.js';
export type { ProjectContext } from './stores/project-context-registry.js';

// Lifecycle
export { LifecycleDispatcher } from './lifecycle/lifecycle-dispatcher.js';
export type { DispatchInput, DispatchOutput } from './lifecycle/lifecycle-dispatcher.js';
export type { ExecutionContext } from './lifecycle/lifecycle-context.js';

// Transport (C1 substrate)
export {
  HTTPListener,
  type HTTPListenerOptions,
  type HTTPRequestHandler,
  isLoopbackAddress,
  shouldRejectNonLoopback,
  isAllowedHostHeader,
} from './transport/index.js';
export { RouteDispatcher } from './transport/route-dispatcher.js';

// Heartbeat
export { ActivityTracker, formatElapsed } from './bounded-execution/activity-tracker.js';
export type {
  ActivityTrackerOptions,
  HeartbeatStage,
  TransitionFields,
  HeartbeatTickInfo,
} from './bounded-execution/activity-tracker.js';

// Agent resolution
export { resolveAgent } from './providers/agent-resolver.js';
export type { ResolvedAgent } from './providers/agent-resolver.js';
export { findModelProfile, getEffectiveCostTier } from './config/model-profile-registry.js';



// Observability
export { TaskEnvelopeStore } from './events/task-envelope.js';
export type { TaskEnvelope, StageRecord, ToolCallRecord } from './events/task-envelope.js';
export { EnvelopeBus } from './events/envelope-bus.js';
export type { BusMessage, Subscriber } from './events/envelope-bus.js';
export { LogWriter } from './events/log-writer.js';
export type { LogWriterOpts } from './events/log-writer.js';
export { TelemetryUploader } from './events/telemetry-uploader.js';
export { toWireRecord } from './events/to-wire-record.js';
export { JsonlWriter } from './events/jsonl-writer.js';
export type { JsonlWriterOptions } from './events/jsonl-writer.js';
export type { TaskCompletedEventSchema, ValidatedTaskCompletedEventSchema } from './events/wire-schema.js';

// Review engine templates (v4.0 lifecycle + 4.3.0 pipeline redesign)


// Reporting slots
export { delegateReportSchema } from './reporting/report-parser-slots/delegate-report.js';
export type { DelegateStructuredReport } from './reporting/report-parser-slots/delegate-report.js';
export { executePlanReportSchema } from './reporting/report-parser-slots/execute-plan-report.js';
export type { ExecutePlanReport } from './reporting/report-parser-slots/execute-plan-report.js';

// Headline templates
export { delegateHeadlineTemplate } from './reporting/headline-templates/delegate.js';
export { executePlanHeadlineTemplate } from './reporting/headline-templates/execute-plan.js';

// Unified task engine
export { TASK_TYPES, TYPE_REGISTRY, getTypeConfig, oppositeAgent } from './unified/type-registry.js';
export type { TaskType, TypeConfig } from './unified/type-registry.js';
export { taskInputSchema } from './unified/task-input-schema.js';
export type { TaskInput } from './unified/task-input-schema.js';
export { loadSkill, validateSkillsExist, clearSkillCache } from './unified/skill-loader.js';
export type { SkillPair } from './unified/skill-loader.js';
export { runTwoPhasePipeline } from './unified/two-phase-pipeline.js';
export type { PipelineInput, PipelineResult, SessionInfo } from './unified/two-phase-pipeline.js';
export { parseReviewerOutput } from './unified/reviewer-output-parser.js';
export type { ReviewerOutput, ReviewerFinding, ParseResult } from './unified/reviewer-output-parser.js';
export { TaskRegistry } from './unified/task-registry.js';
export type { TaskEntry, TaskState } from './unified/task-registry.js';
