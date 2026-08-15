// InitiativeRecordRuntime — the shared application service Group 001B
// adapters (HTTP, MCP, CLI) call into. Owns the ONE `InitiativeRecordStore`
// connection over `<stateDir>/initiatives.db`, validates every operation
// request against the frozen Task I-1 Zod schemas, dispatches mutating and
// simple read operations to the core store, and assembles the single-call
// `initiative_resume` payload (`InitiativeResumeResponse`) from the store's
// joined read methods (Task I-4). Transport-agnostic: this class never sees
// an `IncomingMessage`, the MCP SDK, CLI argv, or `ExecutionRuntime` — see
// .mma/specs/2026-08-12-mma-next-initiative-engine.md (SPEC-001, "Interfaces
// / contracts") for the pinned request/response shapes this transcribes.

import { join } from 'node:path';
import {
  InitiativeRecordStore,
  initiativeOperationRequestSchema,
  initiativeResumeRequestSchema,
  initiativeGateStatusInputSchema,
  initiativeExportRequestSchema,
  initiativeFieldErrorsFromIssues,
  InitiativeInvalidRequestError,
  INITIATIVE_EXPORT_SCHEMA_VERSION,
  type DeliveryContract,
  type InitiativeExportSnapshot,
  type InitiativeRecordEntity,
  type InitiativeResumeResponse,
  type LifecycleResumeBlock,
  type MethodDeclaration,
  INITIATIVE_OPERATIONS,
  type InitiativeOperation,
} from '@zhixuan92/multi-model-agent-core';
import { expandHome } from '../expand-home.js';

/**
 * Every frozen operation `execute()` accepts — DERIVED from the operation registry rather than
 * retyped, so a new operation is executable the moment it is registered.
 *
 * This was a hand-maintained `new Set([...])` of 68 string literals, bound to
 * `INITIATIVE_OPERATIONS` by nothing. Omitting an operation there does not fail to compile; it
 * makes that operation reject at runtime as "not a valid execute() operation", which reads exactly
 * like a caller mistake. The list had also drifted from its own doc comment, which claimed a single
 * exception while three had accumulated.
 *
 * The three exclusions are real and each has a dedicated method, because none is a single store
 * call: `initiative_resume` and `initiative_export` assemble several joined reads, and
 * `initiative_gate_status` evaluates the lifecycle gates.
 */
const DEDICATED_METHOD_OPERATIONS = new Set<InitiativeOperation>([
  'initiative_resume',
  'initiative_gate_status',
  'initiative_export',
]);

const EXECUTE_OPERATIONS: ReadonlySet<InitiativeOperation> = new Set(
  INITIATIVE_OPERATIONS.filter((operation) => !DEDICATED_METHOD_OPERATIONS.has(operation)),
);

/** Names the dedicated method a caller should have used, for each excluded operation. */
const DEDICATED_METHOD_HINT = 'call initiativeResume(), initiativeGateStatus(), or initiativeExport() instead';

export class InitiativeRecordRuntime {
  private closed = false;

  private constructor(private readonly store: InitiativeRecordStore) {}

  /** Resolves `initiatives.db` below the server state directory and opens
   *  (creating or migrating) the dedicated Initiative store — never touches
   *  `executions.db`. */
  static open(opts: { stateDir: string }): InitiativeRecordRuntime {
    const dbPath = join(expandHome(opts.stateDir), 'initiatives.db');
    const store = InitiativeRecordStore.open({ dbPath });
    return new InitiativeRecordRuntime(store);
  }

  /** Closes the store's own connection. Idempotent — safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
  }

  /**
   * Validates `rawRequest` against the frozen operation envelope and
   * dispatches every operation except the three dedicated reads —
   * `initiative_resume` (use {@link initiativeResume}),
   * `initiative_gate_status` (use {@link initiativeGateStatus}), and
   * `initiative_export` (use {@link initiativeExport}) — each of
   * which is a server-side assembly of several joined store reads rather
   * than a single store call: mutating operations go through the store's
   * single transactional `execute()`; read operations call the matching
   * one-per-operation store method. Throws `invalid_request` before any
   * store call for a malformed body, an unknown operation, or a request
   * naming one of the two dedicated reads. Every other typed error
   * (`not_found`, `revision_conflict`, `cross_product_workspace_link`, and —
   * for the Phase A1 operations added by SPEC-002 —
   * `cross_initiative_evidence_link` and `cross_initiative_verification`)
   * passes through unchanged from the store.
   */
  execute(
    rawRequest: unknown,
  ):
    | InitiativeRecordEntity
    | InitiativeRecordEntity[]
    | MethodDeclaration
    | MethodDeclaration[]
    | DeliveryContract
    | DeliveryContract[] {
    const parsed = initiativeOperationRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new InitiativeInvalidRequestError({ field_errors: initiativeFieldErrorsFromIssues(parsed.error.issues) });
    }
    const request = parsed.data;

    if (!EXECUTE_OPERATIONS.has(request.operation)) {
      throw new InitiativeInvalidRequestError({
        field_errors: {
          operation: [
            `${request.operation} is not a valid execute() operation; ${DEDICATED_METHOD_HINT}`,
          ],
        },
      });
    }

    switch (request.operation) {
      case 'product_create':
      case 'workspace_create':
      case 'resource_register':
      case 'initiative_create':
      case 'initiative_status':
      case 'initiative_link_workspace':
      case 'initiative_relate':
      case 'initiative_task_create':
      case 'initiative_task_claim':
      case 'initiative_task_release':
      case 'initiative_task_complete':
      case 'initiative_task_execution':
      case 'artifact_register':
      // Phase A1 mutations (SPEC-002 FR-3): each is one transactional
      // `store.execute()` call, same as every Phase A0 mutation above.
      case 'requirement_add':
      case 'acceptance_criterion_add':
      case 'decision_record':
      case 'decision_supersede':
      case 'evidence_add':
      case 'evidence_link':
      case 'risk_add':
      case 'risk_status':
      case 'verification_record':
      // SPEC-004 Lifecycle Engine mutations (FR-2 through FR-7): each is one
      // transactional `store.execute()` call, same pattern as every mutation
      // above — the store computes the transition/gate rules; this runtime
      // never does.
      case 'initiative_phase_enter':
      case 'initiative_phase_satisfy':
      case 'initiative_phase_reopen':
      case 'initiative_phase_skip':
      case 'initiative_focus_set':
      case 'initiative_set_lifecycle_contract':
      // SPEC-005 Method Registry mutation (FR-5): same pattern as every mutation above — one
      // transactional `store.execute()` call.
      case 'initiative_task_set_method':
      // SPEC-006 Business intake (← AC-1.6): the confirmed-draft composite mutation. Same
      // pattern as every mutation above — the store owns the whole write algorithm; this
      // runtime does nothing beyond validating the envelope and forwarding the request.
      case 'initiative_bootstrap':
      // SPEC-007 Delivery Layer (Task I-3, ← AC-1.5, AC-1.6): the first Deliverable mutations.
      // Same pattern as every mutation above — the store owns the whole write algorithm.
      case 'deliverable_define':
      case 'deliverable_attach_artifact':
      // SPEC-007 Delivery Layer (Task I-4, ← AC-1.6, AC-1.7, AC-1.8, AC-1.9): computed
      // validation and delivery history. Same pattern as every mutation above — the store
      // owns the whole write algorithm; this runtime does nothing beyond validating the
      // envelope and forwarding the request.
      case 'deliverable_validate':
      case 'deliverable_deliver':
      // SPEC-007 Delivery Layer (Task I-6, ← AC-1.7): the maintainer-confirmed human-approval
      // mutation. Same pattern as every mutation above — the store owns the whole write
      // algorithm; this runtime does nothing beyond validating the envelope and forwarding
      // the request.
      case 'deliverable_approve':
      // MMA Next gap-closure (§15, §21 success criterion 12): verification execution,
      // packaging assembly, and Initiative import. Same pattern as every mutation above.
      case 'verification_run':
      case 'deliverable_package':
      case 'initiative_import':
        return this.store.execute(request);

      case 'product_get':
        return this.store.getProduct(request.input);
      case 'product_list':
        return this.store.listProducts();
      case 'workspace_get':
        return this.store.getWorkspace(request.input);
      case 'workspace_list':
        return this.store.listWorkspaces(request.input);
      case 'resource_list':
        return this.store.listResources(request.input);
      case 'initiative_get':
        return this.store.getInitiative(request.input);
      case 'initiative_list':
        return this.store.listInitiatives(request.input);
      case 'initiative_relations':
        return this.store.listInitiativeRelations(request.input);
      case 'initiative_task_get':
        return this.store.getInitiativeTask(request.input);
      case 'initiative_task_list':
        return this.store.listInitiativeTasks(request.input);
      case 'artifact_get':
        return this.store.getArtifact(request.input);

      // Phase A1 reads (SPEC-002 FR-4): each is one stable Task I-5 store
      // read method, same pattern as every Phase A0 read above.
      case 'requirement_get':
        return this.store.getRequirement(request.input);
      case 'requirement_list':
        return this.store.listRequirements(request.input);
      case 'acceptance_criterion_get':
        return this.store.getAcceptanceCriterion(request.input);
      case 'acceptance_criterion_list':
        return this.store.listAcceptanceCriteria(request.input);
      case 'decision_get':
        return this.store.getDecision(request.input);
      case 'decision_list':
        return this.store.listDecisions(request.input);
      case 'evidence_get':
        return this.store.getEvidence(request.input);
      case 'evidence_list':
        return this.store.listEvidence(request.input);
      case 'evidence_links_list':
        return this.store.listEvidenceLinks(request.input);
      case 'risk_get':
        return this.store.getRisk(request.input);
      case 'risk_list':
        return this.store.listRisks(request.input);
      case 'verification_get':
        return this.store.getVerificationRun(request.input);
      case 'verification_list':
        return this.store.listVerificationRuns(request.input);

      // SPEC-005 Method Registry reads (FR-9): one stable Task I-2 store read method each,
      // same pattern as every read above.
      case 'method_get':
        return this.store.getMethod(request.input);
      case 'method_list':
        return this.store.listMethods();

      // SPEC-007 Delivery Layer reads (Task I-3, ← AC-1.4, AC-1.5, AC-1.6): one stable Task I-1/
      // I-3 store read method each, same pattern as every read above.
      case 'delivery_contract_get':
        return this.store.getDeliveryContract(request.input);
      case 'delivery_contract_list':
        return this.store.listDeliveryContracts();
      case 'deliverable_get':
        return this.store.getDeliverable(request.input);
      case 'deliverable_list':
        return this.store.listDeliverables(request.input);

      // The three dedicated reads, named explicitly rather than swept into `default`.
      // `EXECUTE_OPERATIONS` already rejects them before the switch, so these arms are
      // unreachable — but naming them is what lets `default` narrow to `never` below.
      case 'initiative_resume':
      case 'initiative_gate_status':
      case 'initiative_export':
        throw new InitiativeInvalidRequestError({
          field_errors: {
            operation: [`${request.operation} is not a valid execute() operation; ${DEDICATED_METHOD_HINT}`],
          },
        });

      // Now an EXHAUSTIVENESS check, not a catch-all. `EXECUTE_OPERATIONS` is derived from
      // `INITIATIVE_OPERATIONS`, so a newly registered operation becomes executable immediately —
      // and would previously have sailed past that gate only to hit a `default` telling the caller
      // its own registered operation "is not a valid execute() operation". A missing dispatch arm
      // now fails to COMPILE instead, naming the operation.
      default:
        return assertEveryOperationDispatched(request);
    }
  }

  /**
   * Assembles the complete pinned `InitiativeResumeResponse` in one call
   * (FR-13): resolves the Initiative by `uuid` or `human_key`, then its
   * Product, linked Workspaces (each with its Resources), related
   * Initiatives, Tasks, ArtifactRefs, and the newest `event_limit` Events
   * (default 20, valid range 1-100), plus the pinned `counts` block. Throws
   * `invalid_request` for a malformed request (including an `event_limit`
   * outside 1-100) before any store call; throws `not_found` for an unknown
   * Initiative, Product, linked Workspace, or related Initiative.
   */
  initiativeResume(rawRequest: unknown): InitiativeResumeResponse {
    const parsed = initiativeResumeRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new InitiativeInvalidRequestError({ field_errors: initiativeFieldErrorsFromIssues(parsed.error.issues) });
    }
    const request = parsed.data;
    const eventLimit = request.event_limit ?? 20;

    const initiative = this.store.getInitiative(request.initiative);
    const product = this.store.getProduct({ uuid: initiative.product_id });
    const workspaces = this.store.getInitiativeWorkspaceLinks(initiative.uuid);
    const relatedInitiatives = this.store.getRelatedInitiatives(initiative.uuid);
    const tasks = this.store.listInitiativeTasks({ initiative_id: initiative.uuid });
    const artifacts = this.store.listInitiativeArtifacts(initiative.uuid);
    // Installation-wide, not scoped to `initiative.uuid`: `event_sequence` is
    // monotonic per installation (FR-10) and Phase A0's earliest Events (e.g.
    // `product_created`) predate any Initiative, so they carry no
    // `initiative_id`. The pinned resume contract's Data-mapping clause states
    // no per-Initiative scope for `events` (unlike every other collection,
    // which it explicitly scopes) — "the requested final Event window" is the
    // installation's own recent-activity tail, bounded by `event_limit`.
    const allEvents = this.store.listEvents();
    const events = [...allEvents].reverse().slice(0, eventLimit);
    const eventsTotal = allEvents.length;
    const tasksByStatus = this.store.countInitiativeTasksByStatus(initiative.uuid);
    const resourceCount = workspaces.reduce((sum, link) => sum + link.resources.length, 0);

    // Phase A1 professional-record sections (SPEC-002 FR-12/FR-13): each is
    // one stable Task I-5 resume-join store read, same pattern as every
    // Phase A0 join above — no ad hoc queries here.
    const requirements = this.store.getRequirementsWithCriteria(initiative.uuid);
    const decisions = this.store.listDecisions({ initiative_id: initiative.uuid });
    const risks = this.store.getResumeRisks(initiative.uuid);
    const evidence = this.store.listEvidence({ initiative_id: initiative.uuid });
    const verification = this.store.getLatestVerificationRuns(initiative.uuid);
    // SPEC-004 Lifecycle Engine (Task I-4): the additive lifecycle block,
    // assembled by the store from the same synthesized six-phase overlay and
    // live gate evaluator `initiativeGateStatus` below reuses — one shared
    // read helper, not two divergent implementations.
    const lifecycle = this.store.getLifecycleResumeBlock({ uuid: initiative.uuid });
    // MMA Next gap-closure (§15: "resume returns deliverable validation states"): additive —
    // `[]`/all-zero for an Initiative with no Deliverables.
    const deliverables = this.store.listDeliverables({ initiative_id: initiative.uuid });

    const response: InitiativeResumeResponse = {
      initiative,
      product,
      workspaces,
      related_initiatives: relatedInitiatives,
      tasks,
      artifacts,
      events,
      requirements,
      decisions,
      risks,
      evidence,
      verification,
      lifecycle,
      deliverables,
      counts: {
        workspaces: workspaces.length,
        resources: resourceCount,
        related_initiatives: relatedInitiatives.length,
        tasks: tasks.length,
        tasks_by_status: tasksByStatus,
        artifacts: artifacts.length,
        events_returned: events.length,
        events_total: eventsTotal,
        requirements: this.store.countRequirements(initiative.uuid),
        acceptance_criteria: this.store.countAcceptanceCriteria(initiative.uuid),
        decisions_open: this.store.countOpenDecisions(initiative.uuid),
        risks_open: this.store.countOpenRisks(initiative.uuid),
        evidence: this.store.countEvidence(initiative.uuid),
        verification_by_state: this.store.countVerificationByState(initiative.uuid),
        deliverables_by_validation_state: this.store.countDeliverablesByValidationState(initiative.uuid),
      },
    };
    return response;
  }

  /**
   * `initiative_gate_status` (Task I-4, SPEC-004 FR-9): the dedicated
   * read-only lifecycle method, outside the mutation dispatcher exactly like
   * {@link initiativeResume}. Validates `rawRequest` against the Task I-1
   * strict `initiativeGateStatusInputSchema` (a bare Initiative lookup — no
   * mutation controls, no caller provenance, no caller-selected event
   * limit), then returns the SAME `LifecycleResumeBlock` `initiativeResume`
   * embeds, assembled by the store's one shared read helper. Throws
   * `invalid_request` for a malformed lookup before any store call; throws
   * `not_found` for an unknown Initiative. Performs no write.
   */
  initiativeGateStatus(rawRequest: unknown): LifecycleResumeBlock {
    const parsed = initiativeGateStatusInputSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new InitiativeInvalidRequestError({ field_errors: initiativeFieldErrorsFromIssues(parsed.error.issues) });
    }
    return this.store.getLifecycleResumeBlock(parsed.data.initiative);
  }

  /**
   * `initiative_export` (MMA Next gap-closure, §15, §21 success criterion 12): the third
   * dedicated read, alongside `initiativeResume` and `initiativeGateStatus` above — a
   * server-side assembly of several joined store reads, never a single store call. Assembles
   * the complete, self-contained portable `InitiativeExportSnapshot` for one Initiative: throws
   * `invalid_request` for a malformed lookup before any store call, `not_found` for an unknown
   * Initiative. Performs no write.
   */
  initiativeExport(rawRequest: unknown): InitiativeExportSnapshot {
    const parsed = initiativeExportRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new InitiativeInvalidRequestError({ field_errors: initiativeFieldErrorsFromIssues(parsed.error.issues) });
    }
    const initiative = this.store.getInitiative(parsed.data.initiative);
    const product = this.store.getProduct({ uuid: initiative.product_id });
    const workspaces = this.store.listInitiativeWorkspaceLinksWithDetail({ initiative_id: initiative.uuid });
    const tasks = this.store.listInitiativeTasks({ initiative_id: initiative.uuid });
    const artifacts = this.store.listInitiativeArtifacts(initiative.uuid);
    const requirements = this.store.listRequirements({ initiative_id: initiative.uuid });
    const acceptanceCriteria = this.store.listAcceptanceCriteria({ initiative_id: initiative.uuid });
    const decisions = this.store.listDecisions({ initiative_id: initiative.uuid });
    const evidence = this.store.listEvidence({ initiative_id: initiative.uuid });
    const risks = this.store.listRisks({ initiative_id: initiative.uuid });
    const verificationRuns = this.store.listVerificationRuns({ initiative_id: initiative.uuid });
    const phaseRecords = this.store.listPhaseRecords({ initiative_id: initiative.uuid });
    const deliverables = this.store.listDeliverables({ initiative_id: initiative.uuid }).map((deliverable) => ({
      deliverable,
      members: this.store.listDeliverableMembers({ deliverable_id: deliverable.uuid }),
      history: this.store.listDeliveryHistory({ deliverable_id: deliverable.uuid }),
    }));
    const events = this.store.listEvents({ initiative_id: initiative.uuid });

    const snapshot: InitiativeExportSnapshot = {
      schema_version: INITIATIVE_EXPORT_SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      initiative,
      product,
      workspaces,
      tasks,
      artifacts,
      requirements,
      acceptance_criteria: acceptanceCriteria,
      decisions,
      evidence,
      risks,
      verification_runs: verificationRuns,
      phase_records: phaseRecords,
      deliverables,
      events,
    };
    return snapshot;
  }
}

/** Fails to COMPILE when a registered operation reaches `execute()`'s switch with no dispatch arm.
 *  Reached at runtime only if the type system was bypassed, so it still throws rather than
 *  returning something a caller would treat as a result. */
function assertEveryOperationDispatched(request: never): never {
  const operation = (request as { operation?: unknown }).operation;
  throw new InitiativeInvalidRequestError({
    field_errors: { operation: [`${String(operation)} has no execute() dispatch arm`] },
  });
}
