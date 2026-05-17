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
  RunTasksRuntime,
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
} from './intake/types.js';
export { ParsedStructuredReport } from './reporting/structured-report.js';
export { notApplicableSchema, notApplicable, isNotApplicable, type NotApplicable } from './reporting/not-applicable.js';
export { composeRunningHeadline, type RunningState, type RunningTask } from './reporting/compose-running-headline.js';
export { composeTerminalHeadline, type TerminalHeadlineInput } from './reporting/compose-terminal-headline.js';
export { TerminalStatusDeriver, type WorkerStatus, type OverallReviewVerdict, type ArtifactsCheck, type VerifyOutcome, type TerminalStatus, type TerminalInputs, type TerminalDecision } from './reporting/terminal-status-deriver.js';

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
export { FileBackedContextBlockStore } from './stores/file-backed-context-block-store.js';

// Run tasks
export { runTasks } from './lifecycle/task-runner.js';
export type { RunTasksOptions } from './lifecycle/task-runner.js';

// Lifecycle
export { ToolSurfaceRegistry } from './tool-surface/tool-surface-registry.js';
export type { SurfaceEntry } from './tool-surface/tool-surface-registry.js';
export { registerAllTools, buildToolSurfaceRegistry } from './tool-surface/register-all-tools.js';
export { LifecycleDispatcher } from './lifecycle/lifecycle-dispatcher.js';
export type { DispatchInput, DispatchOutput } from './lifecycle/lifecycle-dispatcher.js';
export type { ExecutionContext } from './lifecycle/lifecycle-context.js';

// Transport (C1 substrate)
export {
  HTTPListener,
  type HTTPListenerOptions,
  type HTTPRequestHandler,
  RouteDispatcher,
  type RouteMetadata,
  type ResponseShape,
  isLoopbackAddress,
  shouldRejectNonLoopback,
  isAllowedHostHeader,
} from './transport/index.js';

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
export { otherTier } from './config/tier-policy-registry.js';

// Intake pipeline
export { compileDelegatePrompt } from './intake/brief-compiler-slots/delegate.js';
export { compileExecutePlan } from './intake/brief-compiler-slots/execute-plan.js';
export type { ExecutePlanInput } from './intake/brief-compiler-slots/execute-plan.js';
export { runIntakePipeline } from './intake/pipeline.js';
export { classifyDraft } from './intake/classify.js';
export { inferMissingFields } from './intake/field-inferer.js';
export { resolveDraft } from './intake/resolve.js';
export { validateSource } from './intake/source-schema.js';
export type {
  DraftTask,
  SourceRoute,
  AnySource,
  DelegateSource,
  ReviewSource,
  DebugSource,
  VerifySource,
  AuditSource,
  ExecutePlanSource,
  ClassificationResult,
  HardError,
  IntakeProgress,
  ReadyDraft,
  IntakeResult,
} from './intake/types.js';
export { createDraftId, parseDraftId, generateRequestId } from './intake/draft-id.js';

// Batch registry
export * from './stores/batch-registry.js';

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
export { specLintTemplate } from './review/templates/spec-review.js';
export { qualityLintTemplate } from './review/templates/quality-review.js';
export { qualityAuditTemplate } from './review/templates/quality-review-audit.js';
export { qualityReviewTemplate } from './review/templates/quality-review-review.js';
export { qualityDebugTemplate } from './review/templates/quality-review-debug.js';
export { qualityInvestigateTemplate } from './review/templates/quality-review-investigate.js';
export { reworkTemplate } from './review/templates/rework.js';
export type { ReviewTemplate } from './review/templates/shared.js';

// Intake-pipeline slots
export type { ReviewPolicy } from './intake/brief-compiler-slots/delegate.js';
export { executePlanSlot } from './intake/brief-compiler-slots/execute-plan.js';
export type { ExecutePlanBrief } from './intake/brief-compiler-slots/execute-plan.js';
export { makeRetrySlot } from './intake/brief-compiler-slots/retry.js';
export type { RetryInput, RetryBrief } from './intake/brief-compiler-slots/retry.js';

// Plan extractor
export { extractPlanSection, PlanExtractionError } from './intake/plan-extractor.js';
export type { PlanSection } from './intake/plan-extractor.js';

// Reporting slots
export { delegateReportSchema } from './reporting/report-parser-slots/delegate-report.js';
export type { DelegateStructuredReport } from './reporting/report-parser-slots/delegate-report.js';
export { executePlanReportSchema } from './reporting/report-parser-slots/execute-plan-report.js';
export type { ExecutePlanReport } from './reporting/report-parser-slots/execute-plan-report.js';

// Headline templates
export { delegateHeadlineTemplate } from './reporting/headline-templates/delegate.js';
export { executePlanHeadlineTemplate } from './reporting/headline-templates/execute-plan.js';
