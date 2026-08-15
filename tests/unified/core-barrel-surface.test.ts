import { describe, it, expect } from 'vitest';
import * as barrel from '../../packages/core/src/index.js';

/**
 * The published runtime surface of `@zhixuan92/multi-model-agent-core`, pinned.
 *
 * This file previously asserted that five of the barrel's exports were functions, under the
 * title "core/index.js re-exports all unified API symbols" — which it could not see. Meanwhile
 * the barrel had grown to 146 runtime exports, of which a large share have no consumer anywhere
 * in this repository, and nothing distinguished a deliberate public API from a symbol that
 * leaked out of a module and was never used again.
 *
 * A list is the only thing that can tell those apart, because the difference is INTENT. Pinning
 * it makes every addition and every removal a decision someone made on purpose — the same
 * ratchet this repo already applies to the route manifest and the observability event set. It
 * does not claim every name below is load-bearing; it claims nobody adds one by accident.
 *
 * TYPE-only exports are deliberately not pinned: they are erased at build time, so a dormant
 * one ships no bytes and costs nothing at runtime. A dormant VALUE is shipped code.
 *
 * Updating this list is the normal way to add an export. Deleting a name from it without
 * deleting the export is not — the assertion is exact in both directions.
 */
const PUBLISHED_RUNTIME_EXPORTS = [
  'ACCEPTED_CHECK_ROOTS', 'AGENT_PLUGIN_CLIENT', 'CLIENT_IDS', 'ContractPlanError', 'CorpusIndex',
  'CrossInitiativeEvidenceLinkError', 'CrossInitiativeVerificationError', 'CrossProductWorkspaceLinkError',
  'DEFAULT_COMMAND_TIMEOUT_MS', 'DEFAULT_EFFORT', 'DEFAULT_LIFECYCLE_CONTRACT_ID', 'DISPOSITIONS',
  'DuplicateTargetAdapterError', 'EnvelopeBus', 'ExecutionRegistry', 'HTTPListener',
  'INITIATIVE_EVENT_PAYLOAD_KEYS', 'INITIATIVE_EVENT_TYPES', 'INITIATIVE_EXPORT_SCHEMA_VERSION',
  'INITIATIVE_OPERATIONS', 'InMemoryContextBlockStore', 'InitiativeAlreadyExistsError',
  'InitiativeInvalidRequestError', 'InitiativeNotFoundError', 'InitiativeRecordStore',
  'InvalidPhaseTransitionError', 'InvalidTaskTransitionError', 'JOURNAL_INDEX_DB_FILENAME',
  'JOURNAL_INDEX_SCHEMA_VERSION', 'JournalIndexStore', 'JournalStore', 'JsonlWriter',
  'LIFECYCLE_PHASES', 'LogWriter', 'MAX_CAPTURED_OUTPUT_BYTES', 'MAX_COMMAND_TIMEOUT_MS',
  'MCP_BRIDGE_CLIENT_IDS', 'METHOD_ID_PATTERN', 'MigrationBackupFailedError', 'PortInUseError',
  'REFINER_SCHEMAS', 'RevisionConflictError', 'RouteDispatcher', 'SPEC_COMPONENTS',
  'SPEC_COMPONENT_CATALOG', 'TASK_TYPES', 'TYPE_REGISTRY', 'TargetAdapterValidationFailedError',
  'TaskClaimConflictError', 'TaskNotClaimableError', 'TelemetryUploader',
  'UnknownDeliveryContractError', 'UnknownLifecycleContractError', 'UnknownMethodError',
  'VERIFICATION_METHODS', 'VerificationMethodNotRunnableError', 'WRITING_STYLE_BLOCK',
  'acceptanceClosed', 'approvedContractSchema', 'assertRunnable', 'assertSafeAcceptanceTestPaths',
  'canonicalContractDigest', 'canonicalDigest', 'canonicalSubjectDigest', 'canonicalizeValue',
  'classifyAuthFailure', 'collectInlineApiKeyOffenders', 'commandCheckSchema', 'compareByCodePoint',
  'contractApprovalSchema', 'createProjectContext', 'createProvider', 'declaredArtifactSchema',
  'declaredReferenceSchema', 'deliverableAcceptanceSchema', 'deliveryContractDeclarationSchema',
  'deliveryContractGetInputSchema', 'deliveryContractListInputSchema', 'describeSelectorFailure',
  'dispatchedTasksFromSnapshot', 'draftContractSchema', 'evaluateLifecycleGate',
  'extractEvidenceSections', 'findModelProfile', 'getClaudeOAuth', 'getTypeConfig',
  'initiativeBootstrapInputSchema', 'initiativeExportRequestSchema', 'initiativeFieldErrorsFromIssues',
  'initiativeFocusSetInputSchema', 'initiativeGateStatusInputSchema', 'initiativeLookupSchema',
  'initiativeMutationRequestSchema', 'initiativeOperationRequestSchema', 'initiativePhaseEnterInputSchema',
  'initiativePhaseReopenInputSchema', 'initiativePhaseSatisfyInputSchema', 'initiativePhaseSkipInputSchema',
  'initiativeResumeRequestSchema', 'initiativeSetLifecycleContractInputSchema',
  'initiativeTaskSetMethodInputSchema', 'isAllowedHostHeader', 'isClosingRecord', 'isInitiativeError',
  'isLoopbackAddress', 'isNotApplicable', 'loadAuthToken', 'loadConfigFromFile', 'loadDeliveryPackager',
  'loadMethodGuidance', 'loadSkill', 'materializeAcceptanceTests', 'methodDeclarationSchema',
  'methodGetInputSchema', 'methodListInputSchema', 'multiModelConfigSchema', 'normalizeArtifactPath',
  'normalizeModel', 'notApplicable', 'notApplicableSchema', 'oppositeAgent', 'parseConfig',
  'parseContractPlan', 'parseRecordDecisions', 'parseReviewerOutput', 'proposedContractSchema',
  'provenanceSchema', 'registerTargetAdapter', 'rematerializeAcceptanceTests', 'resolveAgent',
  'resolveComponentHeading', 'resolveComponents', 'resolveConfiguredApiKey', 'resolveConfiguredAuthMode',
  'resolveEffort', 'resolveSelectors', 'resolveTargetAdapter', 'resolvedReferenceSchema',
  'runTwoPhasePipeline', 'searchCandidatesForRecall', 'searchCandidatesForRecord',
  'searchCandidatesForRecordBatch', 'serverConfigSchema', 'shouldRejectNonLoopback', 'taskInputSchema',
  'toWireRecord',
];

describe('published core barrel surface', () => {
  it('exports exactly the pinned set of runtime symbols — no accidental additions or removals', () => {
    expect(Object.keys(barrel).sort()).toEqual([...PUBLISHED_RUNTIME_EXPORTS].sort());
  });

  /**
   * Test seams stay OUT, permanently.
   *
   * `__setCoreTestProviderOverride` redirects every tier's provider process-wide. It was once
   * re-exported here, which made a global provider-swap hook part of the published API of a
   * package any consumer's dependency tree could reach. `index.ts` records the decision in a
   * comment; this is the part that enforces it.
   */
  it('publishes no test seam', () => {
    expect(Object.keys(barrel).filter((name) => name.startsWith('__'))).toEqual([]);
  });

  it('the unified API symbols are callable, not merely present', () => {
    expect(typeof barrel.getTypeConfig).toBe('function');
    expect(typeof barrel.oppositeAgent).toBe('function');
    expect(typeof barrel.taskInputSchema.safeParse).toBe('function');
    expect(typeof barrel.parseReviewerOutput).toBe('function');
    expect(barrel.TASK_TYPES).toHaveLength(12);
  });
});
