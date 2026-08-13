// InitiativeLinker — the outbox consumer for Task I-5 (SPEC-003 Phase B, workstream 003A).
//
// Reads `ExecutionStore`'s outbox (one row per LINKED terminal Execution, written in the same
// SQLite transaction as the terminal CAS — see `execution-store.ts`) and replays each row
// through the server-owned `InitiativeRecordRuntime`: an execution-result Evidence, a commit
// Evidence for a write-route Execution that actually landed a commit, an EvidenceLink to the
// linked Task for each Evidence created, and the Task's execution/terminal transition. No
// execution path writes `initiatives.db` directly — this is the ONLY writer.
//
// A row whose linkage carries no `task_uuid` (Initiative-only linkage, SPEC-003 B6 defect 1)
// takes the separate `replayInitiativeOnlyRow` path: Evidence records directly against the
// Initiative, no EvidenceLink (no representable target type), no Task registration or
// transition.
//
// Every write step carries a stable `outbox:<executionId>:<step>` idempotency key, so a partial
// failure (crash, revision conflict, a concurrent human claim) is always safe to retry:
// `replayOutbox()` is invoked after every terminal execution write (`ExecutionRuntime`) AND at
// boot after pending-execution fencing (`reconcileOnBoot`), and a row's `consumed_at` is set
// only after every step for that row has succeeded. A failed Execution NEVER produces a Task
// status of `failed` — see `terminalTaskUpdate`.
//
// SPEC-003 B6 round-2 defect B (Option 1): linkage is attached to the pending execution row at
// admission, BEFORE the admission-time Task transition runs (`ExecutionRuntime.submit`) — so a
// crash anywhere from admission onward still produces this outbox row, even when that Task
// transition never actually landed. `replayRow`'s Task-update step (below) is tolerant of exactly
// that: it treats "the Task never entered `in_progress` for this execution" as nothing to undo.
//
// The guarantee this consumer actually makes: durable Evidence for every linked terminal
// execution (Steps 1-4, unconditional), and the FR-9 Task mapping applied WHEN the live Task
// record still admits it. It does not guarantee the Task mapping always lands — a Task's live
// record is owned by whichever actor (human or another execution) mutates it last, and that
// actor can complete, cancel, release, or reclaim the Task between this row's admission and its
// replay. SPEC-003 B6 round-3: when the Task-update step's attempted mutation is rejected with a
// SEMANTIC error (`invalid_task_transition` / `task_not_claimable` / `task_claim_conflict`), the
// live record has moved on and no longer admits this historical outcome. The record is
// authoritative, not this row: the divergence is logged and the row is consumed anyway — Steps
// 1-4 already made the execution's own history durable, which is the outbox's real job, so
// retrying a Task mutation the live record will never accept would only wedge the row forever.
// Transient/unknown errors and `revision_conflict` are not semantic and keep the existing retry
// behavior.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  getTypeConfig,
  InvalidTaskTransitionError,
  TaskClaimConflictError,
  TaskNotClaimableError,
  type Evidence,
  type Initiative,
  type Task,
  type TaskType,
  type InitiativeProvenance,
} from '@zhixuan92/multi-model-agent-core';
import type { ExecutionStore, OutboxRecord } from './execution-store.js';
import type { InitiativeRecordRuntime } from './initiative-record-runtime.js';

/** The outbox payload's `linkage` shape (mirrors `ExecutionLinkage` in `execution-store.ts`),
 *  Zod-validated here at the consumption boundary rather than trusted from the durable row.
 *  `task_uuid` is OPTIONAL (frozen interface, AC-1.1) — its absence marks Initiative-only
 *  linkage, replayed by {@link InitiativeLinker.replayInitiativeOnlyRow} instead of the
 *  Task-scoped path. */
const linkagePayloadSchema = z
  .object({
    initiative: z.union([
      z.object({ uuid: z.string().uuid() }).strict(),
      z.object({ human_key: z.string().min(1) }).strict(),
    ]),
    task_uuid: z.string().uuid().optional(),
    authorized_by: z.string().min(1),
  })
  .strict();

/** The outbox row's full JSON payload — written by `ExecutionStore#terminalize` in the same
 *  transaction as the terminal CAS. `terminal_envelope` is deliberately `z.unknown()`: its
 *  shape varies by task type and failure path, and this consumer only ever reads a few
 *  well-known optional fields off it (never assumes the rest). */
const outboxPayloadSchema = z
  .object({
    linkage: linkagePayloadSchema,
    execution_id: z.string().min(1),
    state: z.enum(['complete', 'failed', 'cancelled', 'interrupted']),
    terminal_envelope: z.unknown(),
  })
  .strict();

type OutboxPayload = z.infer<typeof outboxPayloadSchema>;

/** The five terminal outcomes a linked Execution can reach, normalized from the outbox row's
 *  `state` plus (for `state: 'complete'`) the terminal envelope's own `execution.status`. */
export type ExecutionOutcomeStatus = 'completed' | 'done_with_concerns' | 'failed' | 'cancelled' | 'interrupted';

/**
 * The Task transition + outcome a given `ExecutionOutcomeStatus` requires (SPEC-003 Phase B,
 * frozen FR-9 transition matrix — TRANSCRIPTION, not design). A failed Execution NEVER produces
 * a Task status of `failed`: it moves the Task to `blocked` instead, leaving it open for a
 * human or a retried Execution to resolve. `cancelled`/`interrupted` both reopen the Task —
 * neither is a verdict on the work, just "this attempt did not finish."
 */
export function terminalTaskUpdate(
  status: ExecutionOutcomeStatus,
): { transition: 'completed' | 'blocked' | 'open'; outcome: 'succeeded' | 'succeeded_with_concerns' | undefined } {
  switch (status) {
    case 'completed':
      return { transition: 'completed', outcome: 'succeeded' };
    case 'done_with_concerns':
      return { transition: 'completed', outcome: 'succeeded_with_concerns' };
    case 'failed':
      return { transition: 'blocked', outcome: undefined };
    case 'cancelled':
      return { transition: 'open', outcome: undefined };
    case 'interrupted':
      return { transition: 'open', outcome: undefined };
  }
}

/** Normalizes an outbox row's `state` into the five-way `ExecutionOutcomeStatus`. Only
 *  `state: 'complete'` is ambiguous — the pipeline's own success-with-concerns distinction
 *  lives in the terminal envelope's `execution.status`, never in the outbox `state` column (which
 *  only ever distinguishes complete/failed/cancelled/interrupted). */
function deriveOutcomeStatus(state: OutboxPayload['state'], envelope: unknown): ExecutionOutcomeStatus {
  if (state !== 'complete') return state;
  const raw = (envelope as { execution?: { status?: unknown } } | null)?.execution?.status;
  return raw === 'done_with_concerns' ? 'done_with_concerns' : 'completed';
}

/** Best-effort headline summary text for the execution-result Evidence — status, cost, and
 *  duration, read from the terminal envelope's `metrics` block where present. Never throws: a
 *  malformed or absent `metrics` block degrades to "unknown" rather than blocking the whole
 *  replay over a cosmetic field. */
function buildExecutionSummary(status: ExecutionOutcomeStatus, envelope: unknown): string {
  const metrics = (envelope as { metrics?: { totalCostUsd?: unknown; totalDurationMs?: unknown } } | null)?.metrics;
  const cost = typeof metrics?.totalCostUsd === 'number' ? `$${metrics.totalCostUsd.toFixed(4)}` : 'unknown';
  const duration = typeof metrics?.totalDurationMs === 'number' ? `${metrics.totalDurationMs}ms` : 'unknown';
  return `status=${status} cost=${cost} duration=${duration}`;
}

/** SHA-256 hex of the terminal envelope's JSON — deterministic across replay attempts because
 *  the envelope is read from the immutable stored outbox payload (same parsed object, same
 *  `JSON.stringify` key order, every attempt). */
function hashTerminalEnvelope(envelope: unknown): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

/** Best-effort `writeRoute` lookup for an execution's task type. Returns `false` for an
 *  unregistered/unknown type rather than throwing — commit Evidence is skipped, never a reason
 *  to fail the whole row over a type this consumer does not need to recognize. */
function isWriteRouteType(type: string): boolean {
  try {
    return getTypeConfig(type as TaskType).writeRoute;
  } catch {
    return false;
  }
}

/** A write route may deliberately produce no commit. The terminal envelope's
 * engine-measured `output.filesChanged` is non-empty only when the route committed, so it
 * distinguishes that case from an existing repository HEAD that predates this execution. */
function terminalEnvelopeHasCommit(envelope: unknown): boolean {
  const filesChanged = (envelope as { output?: { filesChanged?: unknown } } | null)?.output?.filesChanged;
  return Array.isArray(filesChanged) && filesChanged.length > 0;
}

/** The commit-time SHA persisted on the terminal envelope (SPEC-003 B6 defect 2), read back at
 *  replay time instead of re-derived from live git state. Live `git rev-parse HEAD` at replay
 *  is wrong the moment a LATER commit lands in `cwd` before this row replays — this consumer
 *  would then durably attribute that later, unrelated commit as evidence of THIS execution's
 *  work. `output.commitSha` is the exact `CommitOutcome.head` the pipeline captured the instant
 *  it committed (`two-phase-pipeline.ts`), so it never drifts with later git activity. */
function readPersistedCommitSha(envelope: unknown): string | null {
  const sha = (envelope as { output?: { commitSha?: unknown } } | null)?.output?.commitSha;
  return typeof sha === 'string' && sha.length > 0 ? sha : null;
}

/** SPEC-003 B6 round-3: the three typed errors that mean the Task's LIVE record no longer admits
 *  the historical outcome this outbox row describes — another actor completed, cancelled,
 *  released, or reclaimed the Task since `validateLinkedTask` read it. Anything else (a
 *  transient failure, an unrecognized error, or `revision_conflict` — a genuine race this pass
 *  or the next should retry against) is NOT semantic and must keep retrying as before. */
function isSemanticTaskRejection(
  err: unknown,
): err is InvalidTaskTransitionError | TaskNotClaimableError | TaskClaimConflictError {
  return (
    err instanceof InvalidTaskTransitionError ||
    err instanceof TaskNotClaimableError ||
    err instanceof TaskClaimConflictError
  );
}

/** System provenance for every write this consumer makes. `authorized_by` carries forward the
 *  linkage's own authorization (the identity that authorized the linked Execution at
 *  admission) rather than a system constant, so the Event trail still names who is accountable
 *  for the change even though the write itself is system-driven. */
function systemProvenance(authorizedBy: string): InitiativeProvenance {
  return {
    actor_type: 'system',
    actor_id: 'system:initiative-linker',
    interface: 'system',
    initiated_by: 'system:initiative-linker',
    authorized_by: authorizedBy,
    timestamp: new Date().toISOString(),
    source: 'execution_outbox',
  };
}

export interface InitiativeLinkerDeps {
  store: ExecutionStore;
  initiativeRuntime: InitiativeRecordRuntime;
  /** Diagnostics sink for a row that failed to fully replay — names `outbox_id` (the execution
   *  id) and the error. Defaults to stderr, matching every other application-layer diagnostic
   *  line in this codebase (`[mma] event=... `). */
  log?: (line: string) => void;
}

/** Consumes `ExecutionStore`'s linkage outbox — see the module doc above. */
export class InitiativeLinker {
  private readonly store: ExecutionStore;
  private readonly runtime: InitiativeRecordRuntime;
  private readonly log: (line: string) => void;

  constructor(deps: InitiativeLinkerDeps) {
    this.store = deps.store;
    this.runtime = deps.initiativeRuntime;
    this.log = deps.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  }

  /**
   * Replays every unconsumed outbox row, oldest first. A row that fails partway leaves
   * `consumed_at` unset — it is retried on the NEXT call (a later terminal execution, or the
   * next boot) — and this method itself never throws: one row's failure is logged and replay
   * continues with the rest, so a single bad row can never block every other row behind it.
   */
  replayOutbox(): void {
    for (const row of this.store.listUnconsumedOutbox()) {
      try {
        this.replayRow(row);
        this.store.markOutboxConsumed(row.executionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(
          `[mma] event=initiative_link_failed ts=${new Date().toISOString()} outbox_id=${row.executionId} error="${message.replace(/"/g, '\\"')}"`,
        );
      }
    }
  }

  private replayRow(row: OutboxRecord): void {
    const parsed = outboxPayloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      throw new Error(`invalid outbox payload for execution ${row.executionId}: ${parsed.error.message}`);
    }
    const { linkage, execution_id: executionId, state, terminal_envelope: terminalEnvelope } = parsed.data;
    const provenance = systemProvenance(linkage.authorized_by);
    const taskUuid = linkage.task_uuid;

    // Initiative-only linkage (SPEC-003 B6 defect 1): no Task was named at admission, so there
    // is no Task to scope writes to, check membership against, or transition. Replayed on its
    // own path — every write below is scoped to the Initiative directly.
    if (taskUuid === undefined) {
      this.replayInitiativeOnlyRow(linkage.initiative, executionId, state, terminalEnvelope, provenance);
      return;
    }

    // Resolve the linked Task FIRST — every write below scopes to its `initiative_id`. A Task
    // that no longer exists fails the row loudly (typed `not_found`) rather than silently
    // orphaning Evidence under the wrong Initiative.
    const task = this.runtime.execute({
      operation: 'initiative_task_get',
      input: { uuid: taskUuid },
    }) as Task;

    const status = deriveOutcomeStatus(state, terminalEnvelope);

    // Step 1 — execution-result Evidence at execution://<executionId>. The locator is unique
    // per Execution, so this is always a create (`expected_revision: 0`) on the FIRST
    // successful attempt; a retry after a LATER step failed replays the exact same
    // (operation, input, expected_revision, provenance-minus-timestamp) tuple, so the store's
    // idempotency cache returns the cached result without re-touching the row.
    const executionEvidence = this.runtime.execute({
      operation: 'evidence_add',
      input: {
        initiative_id: task.initiative_id,
        kind: 'execution_result',
        locator: `execution://${executionId}`,
        content_hash: hashTerminalEnvelope(terminalEnvelope),
        summary: buildExecutionSummary(status, terminalEnvelope),
      },
      expected_revision: 0,
      idempotency_key: `outbox:${executionId}:execution_evidence`,
      provenance,
    }) as Evidence;

    // Step 2 — link it to the Task. `evidence_link`'s composite identity is itself an
    // identity-level no-op on a duplicate, so this is safe to replay regardless of idempotency
    // key cache state.
    this.runtime.execute({
      operation: 'evidence_link',
      input: { evidence_id: executionEvidence.uuid, target_type: 'task', target_id: task.uuid },
      expected_revision: 0,
      idempotency_key: `outbox:${executionId}:execution_link`,
      provenance,
    });

    // Steps 3/4 — commit Evidence (+ link) for a write-route Execution that actually landed a
    // commit. A write route that made no commit must not attribute its pre-existing HEAD as
    // evidence. Best-effort: a non-git target, an Execution that committed nothing, a read-only
    // route, or a pruned execution row all skip this pair without failing the row.
    const execution = this.store.get(executionId);
    const commitSha = execution && isWriteRouteType(execution.type) && terminalEnvelopeHasCommit(terminalEnvelope)
      ? readPersistedCommitSha(terminalEnvelope)
      : null;
    if (commitSha) {
      const commitEvidence = this.runtime.execute({
        operation: 'evidence_add',
        input: {
          initiative_id: task.initiative_id,
          kind: 'commit',
          locator: `commit://${commitSha}`,
          content_hash: commitSha,
          summary: `commit ${commitSha} for execution ${executionId}`,
        },
        expected_revision: 0,
        idempotency_key: `outbox:${executionId}:commit_evidence`,
        provenance,
      }) as Evidence;
      this.runtime.execute({
        operation: 'evidence_link',
        input: { evidence_id: commitEvidence.uuid, target_type: 'task', target_id: task.uuid },
        expected_revision: 0,
        idempotency_key: `outbox:${executionId}:commit_link`,
        provenance,
      });
    }

    // Step 5 — the Task's execution/terminal transition. Admission records `execution_ref`
    // before the execution starts, so its presence alone CANNOT mean this terminal transition
    // is complete. Re-reading the Task's live terminal state makes a retry safe after this
    // mutation succeeded but `markOutboxConsumed` did not: skip only when the exact mapped
    // terminal state is already durable, avoiding a stale `expected_revision` / idempotency-hash
    // mismatch while still completing a Task whose execution reference was appended at admission.
    const liveTask = this.runtime.execute({
      operation: 'initiative_task_get',
      input: { uuid: task.uuid },
    }) as Task;
    const { transition, outcome } = terminalTaskUpdate(status);
    const terminalAlreadyApplied = liveTask.status === transition
      && (outcome === undefined || liveTask.outcome === outcome);

    // SPEC-003 B6 round-2 defect B (Option 1): linkage is now attached to the pending execution
    // row in the SAME write as admission — before the admission-time `open|claimed -> in_progress`
    // transition ever runs (`ExecutionRuntime.submit`). A crash between admission and that
    // transition (or a genuine failure of the transition call itself) therefore still produces
    // this outbox row, but the transition it describes never actually landed. That transition is
    // the SAME write that appends `execution_ref` to the Task (`mutateInitiativeTaskExecution`),
    // so its absence from `executionRefs` here is the reliable signal that the Task never left its
    // pre-admission state for THIS execution. Replaying the mapped transition in that case would
    // apply an FR-9 move the Task's actual current status was never a party to — e.g. `claimed ->
    // open` is not a listed transition (an `invalid_task_transition` throw that retries forever,
    // a permanently stuck outbox row) or `open -> open`, a no-op status write that nonetheless
    // claims a transition that never happened. Neither is correct: there is nothing to undo.
    const neverEnteredInProgress = !liveTask.executionRefs.includes(executionId);

    if (terminalAlreadyApplied) {
      // Nothing to do — a prior replay attempt already applied the mapped terminal state, and
      // only `markOutboxConsumed` failed to land.
      return;
    }

    // Branch selection is unchanged: ref-only append when the Task never entered `in_progress`
    // for this execution (nothing to undo — the same "harmless, idempotent, always valid short
    // of `completed`/`cancelled`" append as before), the full FR-9 transition otherwise. What's
    // new (SPEC-003 B6 round-3) is the single catch below: whichever mutation this attempts, if
    // the store rejects it SEMANTICALLY, the row is consumed instead of retried forever — see the
    // module doc comment and `isSemanticTaskRejection`.
    const attemptedInput = neverEnteredInProgress
      ? { uuid: liveTask.uuid, execution_ref: executionId }
      : { uuid: liveTask.uuid, execution_ref: executionId, transition, ...(outcome !== undefined && { outcome }) };
    const idempotencyKey = neverEnteredInProgress
      ? `outbox:${executionId}:task_execution_ref_only`
      : `outbox:${executionId}:task_execution`;

    try {
      this.runtime.execute({
        operation: 'initiative_task_execution',
        input: attemptedInput,
        expected_revision: liveTask.revision,
        idempotency_key: idempotencyKey,
        provenance,
      });
      if (neverEnteredInProgress) {
        this.log(
          `[mma] event=initiative_link_task_untouched ts=${new Date().toISOString()} outbox_id=${executionId} task=${liveTask.uuid} status=${liveTask.status} reason="Task never entered in_progress for this execution — nothing to undo, execution_ref recorded"`,
        );
      }
    } catch (err) {
      if (!isSemanticTaskRejection(err)) throw err;
      // The live record has moved on since `validateLinkedTask` read it — another actor
      // completed, cancelled, released, or reclaimed the Task — so the historical outcome this
      // row describes no longer applies to it. Reconciliation-complete, not a give-up state: the
      // Evidence steps above already made the execution's own history durable, so log the
      // divergence and consume the row rather than retry a mutation the live record will never
      // accept.
      this.log(
        `[mma] event=initiative_link_task_diverged ts=${new Date().toISOString()} outbox_id=${executionId} task=${liveTask.uuid} status=${liveTask.status} attempted_mutation=${JSON.stringify(attemptedInput)} error_code=${err.code} error="${err.message.replace(/"/g, '\\"')}"`,
      );
    }
  }

  /**
   * Initiative-only linkage replay (SPEC-003 B6 defect 1): no Task was named at admission, so
   * this records execution-result Evidence (and, for a write route that landed a commit, commit
   * Evidence) directly against the Initiative — no Task registration, no Task transition, because
   * there is no Task.
   *
   * `evidence_link`'s `EvidenceLinkTargetType` union (`requirement | acceptance_criterion |
   * decision | verification_run | task`) has no `'initiative'` member — an EvidenceLink from
   * Initiative-scoped Evidence has no representable target, so BOTH link steps (`execution_link`,
   * `commit_link`) are skipped here, deliberately, for every Initiative-only row. The Evidence
   * itself is still created (`evidence_add` takes an `initiative_id` directly, independent of any
   * Task), so the work is still durably recorded — just not additionally cross-linked.
   */
  private replayInitiativeOnlyRow(
    initiativeSelector: OutboxPayload['linkage']['initiative'],
    executionId: string,
    state: OutboxPayload['state'],
    terminalEnvelope: unknown,
    provenance: InitiativeProvenance,
  ): void {
    const initiative = this.runtime.execute({
      operation: 'initiative_get',
      input: initiativeSelector,
    }) as Initiative;

    const status = deriveOutcomeStatus(state, terminalEnvelope);

    // Step 1 — execution-result Evidence at execution://<executionId>, scoped to the Initiative
    // directly. Same idempotency key shape as the Task-scoped path — stable across replays.
    this.runtime.execute({
      operation: 'evidence_add',
      input: {
        initiative_id: initiative.uuid,
        kind: 'execution_result',
        locator: `execution://${executionId}`,
        content_hash: hashTerminalEnvelope(terminalEnvelope),
        summary: buildExecutionSummary(status, terminalEnvelope),
      },
      expected_revision: 0,
      idempotency_key: `outbox:${executionId}:execution_evidence`,
      provenance,
    });

    // Step 2 (Task-scoped step 3/4's counterpart) — commit Evidence for a write-route Execution
    // that actually landed a commit. Reads the persisted commit-time SHA off the terminal
    // envelope (SPEC-003 B6 defect 2) — never live git state.
    const execution = this.store.get(executionId);
    const commitSha = execution && isWriteRouteType(execution.type) && terminalEnvelopeHasCommit(terminalEnvelope)
      ? readPersistedCommitSha(terminalEnvelope)
      : null;
    if (commitSha) {
      this.runtime.execute({
        operation: 'evidence_add',
        input: {
          initiative_id: initiative.uuid,
          kind: 'commit',
          locator: `commit://${commitSha}`,
          content_hash: commitSha,
          summary: `commit ${commitSha} for execution ${executionId}`,
        },
        expected_revision: 0,
        idempotency_key: `outbox:${executionId}:commit_evidence`,
        provenance,
      });
    }

    // No Task registration, no Task transition — there is no Task for an Initiative-only row.
  }
}
