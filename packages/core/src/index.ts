// Config
export { loadConfigFromFile, loadAuthToken, collectInlineApiKeyOffenders } from './config/load.js';
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
  OpenAICompatibleProviderConfig,
  MultiModelConfig,
  RunResult,
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
} from './lifecycle/executors/types.js';
export type {
  EligibilityFailureCheck,
  EligibilityFailure,
  ProviderEligibility,
} from './escalation/types.js';
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
export { createProjectContext } from './stores/project-context-registry.js';
export type { ProjectContext } from './stores/project-context-registry.js';

// Run tasks
export { runTasks } from './lifecycle/dispatch-task.js';
export type { RunTasksOptions } from './lifecycle/dispatch-task.js';

// Lifecycle
export { ToolSurfaceRegistry } from './tool-surface/tool-surface-registry.js';
export type { SurfaceEntry } from './tool-surface/tool-surface-registry.js';
export { LifecycleDispatcher } from './lifecycle/lifecycle-dispatcher.js';
export type { DispatchInput, DispatchOutput, ContextBlockHandler } from './lifecycle/lifecycle-dispatcher.js';
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

// Runner shell
export { RunnerShell } from './providers/runner-shell.js';

// Heartbeat
export { ActivityTracker, formatElapsed } from './bounded-execution/activity-tracker.js';
export type {
  ActivityTrackerOptions,
  HeartbeatStage,
  TransitionFields,
  HeartbeatTickInfo,
} from './bounded-execution/activity-tracker.js';

// Agent resolution
export { resolveAgent } from './escalation/agent-resolver.js';
export type { ResolvedAgent } from './escalation/agent-resolver.js';
export { findModelProfile, getEffectiveCostTier } from './config/model-profile-registry.js';
export { otherTier } from './config/tier-policy-registry.js';

// Intake pipeline
export { compileDelegateTasks, compileDelegatePrompt } from './intake/brief-compiler-slots/delegate.js';
export { compileReviewCode } from './intake/brief-compiler-slots/review.js';
export { compileDebugTask } from './intake/brief-compiler-slots/debug.js';
export { compileVerifyWork } from './intake/brief-compiler-slots/verify.js';
export { compileAuditDocument } from './intake/brief-compiler-slots/audit.js';
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

// Diagnostics
export { createHttpServerLog } from './events/http-server-log.js';
export type {
  HttpServerLog,
  ShutdownCause,
  CreateHttpServerLogOptions,
} from './events/http-server-log.js';

// Observability
export { EventEmitter } from './events/event-emitter.js';
export type { EventSink } from './events/event-emitter.js';
export { LocalLogSink } from './events/local-log-sink.js';
export { TelemetrySink } from './events/telemetry-sink.js';
export type { Recorder } from './events/telemetry-sink.js';
export { Event, EventSchemas, CLOUD_EVENT_NAMES } from './events/observability-events.js';
export type { EventType } from './events/observability-events.js';
export { JsonlWriter } from './events/jsonl-writer.js';
export type { JsonlWriterOptions } from './events/jsonl-writer.js';

// Review engine (v4.0 lifecycle)
export {
  ReviewerEngine,
  ReviewerPromptBuilder,
  specTemplate,
  qualityAPTemplate,
  diffTemplate,
} from './review/reviewer-engine.js';
export type { ReviewTemplate } from './review/reviewer-engine.js';

// Intake-pipeline slots
export { delegateSlot } from './intake/brief-compiler-slots/delegate.js';
export type { DelegateInput, DelegateBrief } from './intake/brief-compiler-slots/delegate.js';
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
