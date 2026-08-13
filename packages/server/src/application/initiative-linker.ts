// InitiativeLinker — the outbox consumer for Task I-5 (SPEC-003 Phase B, workstream 003A).
//
// Reads `ExecutionStore`'s outbox (one row per LINKED terminal Execution, written in the same
// SQLite transaction as the terminal CAS — see `execution-store.ts`) and replays each row
// through the server-owned `InitiativeRecordRuntime`: an execution-result Evidence, a commit
// Evidence for a write-route Execution that actually landed a commit, an EvidenceLink to the
// linked Task for each Evidence created, and the Task's execution/terminal transition. No
// execution path writes `initiatives.db` directly — this is the ONLY writer.
//
// Every write step carries a stable `outbox:<executionId>:<step>` idempotency key, so a partial
// failure (crash, revision conflict, a concurrent human claim) is always safe to retry:
// `replayOutbox()` is invoked after every terminal execution write (`ExecutionRuntime`) AND at
// boot after pending-execution fencing (`reconcileOnBoot`), and a row's `consumed_at` is set
// only after every step for that row has succeeded. A failed Execution NEVER produces a Task
// status of `failed` — see `terminalTaskUpdate`.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import {
  getTypeConfig,
  type Evidence,
  type Task,
  type TaskType,
  type InitiativeProvenance,
} from '@zhixuan92/multi-model-agent-core';
import type { ExecutionStore, OutboxRecord } from './execution-store.js';
import type { InitiativeRecordRuntime } from './initiative-record-runtime.js';

/** The outbox payload's `linkage` shape (mirrors `ExecutionLinkage` in `execution-store.ts`),
 *  Zod-validated here at the consumption boundary rather than trusted from the durable row. */
const linkagePayloadSchema = z
  .object({
    initiative: z.union([
      z.object({ uuid: z.string().uuid() }).strict(),
      z.object({ human_key: z.string().min(1) }).strict(),
    ]),
    task_uuid: z.string().uuid(),
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
 *  `state` plus (for `state: 'complete'`) the terminal envelope's own `task.status`. */
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
 *  lives in the terminal envelope's `task.status`, never in the outbox `state` column (which
 *  only ever distinguishes complete/failed/cancelled/interrupted). */
function deriveOutcomeStatus(state: OutboxPayload['state'], envelope: unknown): ExecutionOutcomeStatus {
  if (state !== 'complete') return state;
  const raw = (envelope as { task?: { status?: unknown } } | null)?.task?.status;
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

/** Best-effort `git rev-parse HEAD` in `cwd`. Returns `null` for a non-git target, a target
 *  with no commits, or any other `git` failure — commit Evidence is skipped, never a reason to
 *  fail the whole row. */
function resolveCommitSha(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const sha = out.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
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

    // Resolve the linked Task FIRST — every write below scopes to its `initiative_id`. A Task
    // that no longer exists fails the row loudly (typed `not_found`) rather than silently
    // orphaning Evidence under the wrong Initiative.
    const task = this.runtime.execute({
      operation: 'initiative_task_get',
      input: { uuid: linkage.task_uuid },
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
      ? resolveCommitSha(execution.cwd)
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
    if (!terminalAlreadyApplied) {
      this.runtime.execute({
        operation: 'initiative_task_execution',
        input: {
          uuid: liveTask.uuid,
          execution_ref: executionId,
          transition,
          ...(outcome !== undefined && { outcome }),
        },
        expected_revision: liveTask.revision,
        idempotency_key: `outbox:${executionId}:task_execution`,
        provenance,
      });
    }
  }
}
