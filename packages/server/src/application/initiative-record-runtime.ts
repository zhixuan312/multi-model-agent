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
  initiativeFieldErrorsFromIssues,
  InitiativeInvalidRequestError,
  type InitiativeRecordEntity,
  type InitiativeResumeResponse,
} from '@zhixuan92/multi-model-agent-core';
import { expandHome } from '../expand-home.js';

/** Every frozen operation `execute()` accepts EXCEPT `initiative_resume`,
 *  which has its own dedicated method (`initiativeResume`) because it is not
 *  a single store call — it is a server-side assembly of several joined reads. */
const EXECUTE_OPERATIONS = new Set([
  'product_create',
  'product_get',
  'product_list',
  'workspace_create',
  'workspace_get',
  'workspace_list',
  'resource_register',
  'resource_list',
  'initiative_create',
  'initiative_get',
  'initiative_list',
  'initiative_status',
  'initiative_link_workspace',
  'initiative_relate',
  'initiative_relations',
  'initiative_task_create',
  'initiative_task_get',
  'initiative_task_list',
  'artifact_register',
  'artifact_get',
  // Phase A1 — professional record and verification ledger (SPEC-002 FR-3, FR-4).
  'requirement_add',
  'requirement_get',
  'requirement_list',
  'acceptance_criterion_add',
  'acceptance_criterion_get',
  'acceptance_criterion_list',
  'decision_record',
  'decision_supersede',
  'decision_get',
  'decision_list',
  'evidence_add',
  'evidence_get',
  'evidence_list',
  'evidence_link',
  'evidence_links_list',
  'risk_add',
  'risk_status',
  'risk_get',
  'risk_list',
  'verification_record',
  'verification_get',
  'verification_list',
]);

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
   * dispatches every operation except `initiative_resume` (use
   * {@link initiativeResume} for that): mutating operations go through the
   * store's single transactional `execute()`; read operations call the
   * matching one-per-operation store method. Throws `invalid_request` before
   * any store call for a malformed body, an unknown operation, or a request
   * naming `initiative_resume`. Every other typed error (`not_found`,
   * `revision_conflict`, `cross_product_workspace_link`, and — for the Phase
   * A1 operations added by SPEC-002 — `cross_initiative_evidence_link` and
   * `cross_initiative_verification`) passes through unchanged from the store.
   */
  execute(rawRequest: unknown): InitiativeRecordEntity | InitiativeRecordEntity[] {
    const parsed = initiativeOperationRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new InitiativeInvalidRequestError({ field_errors: initiativeFieldErrorsFromIssues(parsed.error.issues) });
    }
    const request = parsed.data;

    if (!EXECUTE_OPERATIONS.has(request.operation)) {
      throw new InitiativeInvalidRequestError({
        field_errors: { operation: ['initiative_resume is not a valid execute() operation; call initiativeResume() instead'] },
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

      // `initiative_resume` is excluded above by EXECUTE_OPERATIONS; this
      // branch is unreachable but keeps the switch exhaustive under `request`'s
      // full discriminated-union type.
      default:
        throw new InitiativeInvalidRequestError({
          field_errors: { operation: ['initiative_resume is not a valid execute() operation; call initiativeResume() instead'] },
        });
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
      },
    };
    return response;
  }
}
