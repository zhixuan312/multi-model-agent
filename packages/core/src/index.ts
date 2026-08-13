// Client identity
export { CLIENT_IDS, AGENT_PLUGIN_CLIENT, MCP_BRIDGE_CLIENT_IDS } from './clients/client-id.js';
export type { ClientId, ClientState, CallerClient } from './clients/client-id.js';

// Config
export { loadConfigFromFile, loadAuthToken } from './config/load.js';
export { collectInlineApiKeyOffenders } from './config/config-resolver.js';
export { parseConfig, multiModelConfigSchema, serverConfigSchema, assertRunnable } from './config/schema.js';
export type { ServerConfig, RunnableConfig } from './config/schema.js';

// Types (re-export all)
export type {
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
  Provider,
} from './types.js';
export type {
  RunStatus,
  TokenUsage,
  RunOptions,
  AttemptRecord,
} from './providers/runner-types.js';
export { notApplicableSchema, notApplicable, isNotApplicable, type NotApplicable } from './reporting/not-applicable.js';
export { extractEvidenceSections, type EvidenceParsed } from './reporting/extract-evidence-sections.js';
export { parsePlanHeadings, matchTasks, normalizeHeading, MatchError, type PlanHeading } from './unified/plan-task-matcher.js';
export {
  ContractPlanError,
  parseContractPlan,
  ACCEPTED_CHECK_ROOTS,
  assertSafeAcceptanceTestPaths,
  materializeAcceptanceTests,
  rematerializeAcceptanceTests,
  type PlanAcceptanceTest,
  type ParsedContractTask,
  type ContractPlanSnapshot,
} from './unified/contract-plan.js';
// Context blocks
export {
  InMemoryContextBlockStore,
} from './stores/context-block-tool.js';
export type {
  ContextBlockStore,
  RegisteredBlock,
  InMemoryContextBlockStoreOptions,
} from './stores/context-block-tool.js';

// Provider
export { createProvider, __setCoreTestProviderOverride, __setCoreTestProviderOverrideMap } from './providers/provider-factory.js';
export { resolveEffort } from './providers/effort.js';
export { DEFAULT_EFFORT } from './types/task-spec.js';
export {
  resolveConfiguredApiKey,
  resolveConfiguredAuthMode,
  classifyAuthFailure,
  type ProviderAuthMode,
  type AuthFailureDetails,
} from './providers/provider-factory.js';

// Project context
export { createProjectContext } from './stores/project-context-registry.js';
export type { ProjectContext } from './stores/project-context-registry.js';

// (Lifecycle layer deleted — unified pipeline is the only execution path.)

// Transport (C1 substrate)
export {
  HTTPListener,
  PortInUseError,
  type HTTPListenerOptions,
  type HTTPRequestHandler,
  isLoopbackAddress,
  shouldRejectNonLoopback,
  isAllowedHostHeader,
} from './transport/index.js';
export { RouteDispatcher } from './transport/route-dispatcher.js';


// Agent resolution
export { resolveAgent } from './providers/agent-resolver.js';
export type { ResolvedAgent } from './providers/agent-resolver.js';
export { findModelProfile } from './config/model-profile-registry.js';

// Identity
export { getClaudeOAuth } from './identity/claude-oauth.js';


// Observability
export type { TaskEnvelope, StageRecord, ToolCallRecord } from './events/task-envelope.js';
export { EnvelopeBus } from './events/envelope-bus.js';
export type { BusMessage, Subscriber } from './events/envelope-bus.js';
export { LogWriter } from './events/log-writer.js';
export type { LogWriterOpts } from './events/log-writer.js';
export { TelemetryUploader } from './events/telemetry-uploader.js';
export { toWireRecord, normalizeModel } from './events/to-wire-record.js';
export { JsonlWriter } from './events/jsonl-writer.js';
export type { JsonlWriterOptions } from './events/jsonl-writer.js';
export type { TaskCompletedEventSchema, ValidatedTaskCompletedEventSchema } from './events/wire-schema.js';

// Unified task engine
export { TASK_TYPES, TYPE_REGISTRY, getTypeConfig, oppositeAgent } from './unified/type-registry.js';
export type { TaskType, TypeConfig, TargetAcceptance } from './unified/type-registry.js';
export { WRITING_STYLE_BLOCK } from './unified/writing-style-block.js';
export {
  SPEC_COMPONENTS,
  resolveComponents,
  SPEC_COMPONENT_CATALOG,
  resolveComponentHeading,
} from './unified/spec-components.js';
export type { SpecComponent, SpecComponentCatalogEntry } from './unified/spec-components.js';
// Verification evidence: the shape of what was checked, and the named `subjectDigest`
// algorithm. Exported because closure depends on this package and Forge computing the SAME
// digest for the same output — a second implementation could only ever agree with itself.
export {
  canonicalSubjectDigest,
  isClosingRecord,
  acceptanceClosed,
} from './unified/verification.js';
export type {
  VerificationSubject,
  VerificationOutcome,
  VerificationRecord,
  VerificationFile,
} from './unified/verification.js';
// The single canonical-JSON serialisation both digests are built on.
export { canonicalDigest, canonicalizeValue, compareByCodePoint } from './unified/canonical-json.js';
// Deliverable Contract: shared types, canonical digest, and command execution bounds.
// See packages/core/src/unified/deliverable-contract.ts for the algorithm this digest
// implements and why it is deliberately filesystem-free.
export {
  VERIFICATION_METHODS,
  DISPOSITIONS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_CAPTURED_OUTPUT_BYTES,
  canonicalContractDigest,
  normalizeArtifactPath,
  draftContractSchema,
  proposedContractSchema,
  approvedContractSchema,
  declaredArtifactSchema,
  declaredReferenceSchema,
  resolvedReferenceSchema,
  commandCheckSchema,
  deliverableAcceptanceSchema,
  contractApprovalSchema,
} from './unified/deliverable-contract.js';
export type {
  VerificationMethod,
  Disposition,
  DraftContract,
  ProposedContract,
  ApprovedContract,
  DeclaredArtifact,
  DeclaredReference,
  ResolvedReference,
  CommandCheck,
  DeliverableAcceptance,
  ContractApproval,
} from './unified/deliverable-contract.js';
export { taskInputSchema } from './unified/task-input-schema.js';
export type { TaskInput } from './unified/task-input-schema.js';
export { loadSkill } from './unified/skill-loader.js';
export type { SkillPair } from './unified/skill-loader.js';
export { runTwoPhasePipeline } from './unified/two-phase-pipeline.js';
export type { PipelineInput, PipelineResult, SessionInfo } from './unified/two-phase-pipeline.js';
// Only what a package CONSUMER needs. contractMatchFromReviewer / describeContractMismatch /
// ContractMatchResult stay internal to core — the pipeline is their only caller.
export { dispatchedTasksFromSnapshot, resolveSelectors, describeSelectorFailure } from './unified/contract-match.js';
export type { DispatchedContractTask } from './unified/contract-match.js';
export { parseReviewerOutput } from './unified/reviewer-output-parser.js';
export type { ParseResult } from './unified/reviewer-output-parser.js';
export { REFINER_SCHEMAS, parseRecordDecisions } from './unified/refiner-schemas.js';
export {
  JournalIndexStore,
  JournalStore,
  JOURNAL_INDEX_DB_FILENAME,
  JOURNAL_INDEX_SCHEMA_VERSION,
  searchCandidatesForRecall,
  searchCandidatesForRecord,
  searchCandidatesForRecordBatch,
  CorpusIndex,
} from './journal/index.js';
export type {
  JournalCandidate,
  JournalRecordDecision,
  ApplyRecordInput,
  ApplyRecordResult,
} from './journal/index.js';
export { ExecutionRegistry } from './unified/task-registry.js';
export type { ExecutionEntry, ExecutionState } from './unified/task-registry.js';

// Initiative Record — Phase A0 kernel (see .mma/specs/2026-08-12-mma-next-initiative-engine.md, SPEC-001)
export {
  initiativeOperationRequestSchema,
  initiativeMutationRequestSchema,
  initiativeResumeRequestSchema,
  initiativeLookupSchema,
  provenanceSchema,
  INITIATIVE_OPERATIONS,
  INITIATIVE_EVENT_TYPES,
  RevisionConflictError,
  CrossProductWorkspaceLinkError,
  NotFoundError as InitiativeNotFoundError,
  InvalidRequestError as InitiativeInvalidRequestError,
  MigrationBackupFailedError,
  CrossInitiativeEvidenceLinkError,
  CrossInitiativeVerificationError,
  TaskNotClaimableError,
  TaskClaimConflictError,
  InvalidTaskTransitionError,
  isInitiativeError,
  fieldErrorsFromIssues as initiativeFieldErrorsFromIssues,
  InitiativeRecordStore,
  INITIATIVE_EVENT_PAYLOAD_KEYS,
} from './initiative-record/index.js';
export type {
  Product,
  Workspace,
  Resource,
  Initiative,
  InitiativeWorkspaceLink,
  InitiativeRelation,
  Task,
  TaskStatus,
  ArtifactRef,
  Event,
  Requirement,
  AcceptanceCriterion,
  Decision,
  DecisionStatus,
  Evidence,
  EvidenceLink,
  EvidenceLinkTargetType,
  Risk,
  RiskSeverity,
  RiskStatus,
  VerificationRun,
  VerificationMethod as InitiativeVerificationMethod,
  VerificationState,
  InitiativeResumeRequest,
  InitiativeResumeResponse,
  InitiativeOperation,
  InitiativeOperationRequest,
  InitiativeMutationRequest,
  InitiativeRecordEntity,
  Provenance as InitiativeProvenance,
  MutationControl as InitiativeMutationControl,
  InitiativeError,
  InitiativeErrorCode,
  InitiativeRepository,
} from './initiative-record/index.js';
