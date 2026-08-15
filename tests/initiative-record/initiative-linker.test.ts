import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionStore } from '../../packages/server/src/application/execution-store.js';
import { InitiativeLinker, terminalTaskUpdate } from '../../packages/server/src/application/initiative-linker.js';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';

describe('InitiativeLinker terminal mapping', () => {
  it.each([
    ['completed', { transition: 'completed', outcome: 'succeeded' }],
    ['done_with_concerns', { transition: 'completed', outcome: 'succeeded_with_concerns' }],
    ['failed', { transition: 'blocked', outcome: undefined }],
    ['cancelled', { transition: 'open', outcome: undefined }],
    ['interrupted', { transition: 'open', outcome: undefined }],
  ] as const)('maps %s without a failed Task terminal state', (status, expected) => {
    expect(terminalTaskUpdate(status)).toEqual(expected);
  });
});

// SPEC-003 B6 round-3 — the linker's Task-update step must consume a row instead of retrying it
// forever when the live Task record no longer admits the historical outcome the row describes.
// Mirrors `tests/server/application/reconcile.test.ts`'s crash-window style: exercises
// `InitiativeLinker` directly against `ExecutionStore` + `InitiativeRecordRuntime`, no HTTP.
describe('InitiativeLinker Task-update semantic-rejection consumption (SPEC-003 B6 round-3)', () => {
  const provenance = {
    actor_type: 'human' as const,
    actor_id: 'host-a',
    interface: 'test',
    initiated_by: 'host-a',
    authorized_by: 'host-a',
    timestamp: 'ignored',
    source: 'test',
  };

  let execDir: string;
  let store: ExecutionStore;
  let initiativeStateDir: string;
  let initiativeRuntime: InitiativeRecordRuntime;

  beforeEach(() => {
    execDir = mkdtempSync(join(tmpdir(), 'mma-linker-b6r3-exec-'));
    store = new ExecutionStore({ dbPath: join(execDir, 'executions.db'), ttlMs: 3_600_000 });
    initiativeStateDir = mkdtempSync(join(tmpdir(), 'mma-linker-b6r3-initiative-'));
    initiativeRuntime = InitiativeRecordRuntime.open({ stateDir: initiativeStateDir });
  });
  afterEach(() => {
    store.close();
    initiativeRuntime.close();
    rmSync(execDir, { recursive: true, force: true });
    rmSync(initiativeStateDir, { recursive: true, force: true });
  });

  function seedInitiativeAndTask(slug: string): { initiativeUuid: string; taskUuid: string } {
    const product = initiativeRuntime.execute({
      operation: 'product_create', input: { name: 'MMA', slug }, expected_revision: 0, provenance,
    }) as { uuid: string };
    const initiative = initiativeRuntime.execute({
      operation: 'initiative_create',
      input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
      expected_revision: 0, provenance,
    }) as { uuid: string };
    const task = initiativeRuntime.execute({
      operation: 'initiative_task_create',
      input: { initiative_id: initiative.uuid, title: 'T', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [] },
      expected_revision: 0, provenance,
    }) as { uuid: string };
    return { initiativeUuid: initiative.uuid, taskUuid: task.uuid };
  }

  // The outbox is designed to outlive the execution row it describes: an unconsumed row is never
  // pruned at any age, while terminal execution rows expire on their TTL. Commit Evidence used to
  // be gated on `store.get(executionId)` for the task type, so a replay that happened after that
  // pruning silently recorded no commit Evidence and consumed the row anyway — the Initiative
  // permanently missing evidence of work that WAS committed.
  it('records commit Evidence even when the execution row was pruned before replay', () => {
    const { initiativeUuid, taskUuid } = seedInitiativeAndTask('mma-pruned-before-replay');
    const linkage = { initiative: { uuid: initiativeUuid }, task_uuid: taskUuid, authorized_by: 'host-a' };

    store.admit('pruned-before-replay', 'delegate', '/repo', process.pid, linkage);
    store.complete('pruned-before-replay', JSON.stringify({
      execution: { executionId: 'pruned-before-replay', type: 'delegate', status: 'done' },
      output: { filesChanged: ['src/a.ts'], commitSha: 'deadbeefcafe' },
    }));

    // The delay this models: the row could not replay promptly, and the execution row aged out.
    store.pruneExpired(Date.now() + 7_200_000);
    expect(store.get('pruned-before-replay'), 'the execution row is gone').toBeUndefined();
    expect(store.listUnconsumedOutbox(), 'the outbox row survives it').toHaveLength(1);

    new InitiativeLinker({ store, initiativeRuntime, log: () => {} }).replayOutbox();

    const resumed = initiativeRuntime.initiativeResume({ initiative: { uuid: initiativeUuid } }) as {
      evidence: Array<{ kind: string; locator: string }>;
    };
    const commitEvidence = resumed.evidence.find((e) => e.kind === 'commit');
    expect(commitEvidence, 'commit Evidence must not depend on a row the design lets expire').toBeDefined();
    expect(commitEvidence!.locator).toBe('commit://deadbeefcafe');
  });

  // Round-3 finding 1: a Task completed/cancelled by another actor between validation and commit
  // leaves a failed linked execution whose replay tries a ref-only append the store rejects on a
  // terminal Task (`invalid_task_transition`) — previously retried forever.
  it('a Task completed by another actor before replay: replay still records Evidence, logs the divergence, and consumes the row without touching the completed Task', () => {
    const { initiativeUuid, taskUuid } = seedInitiativeAndTask('mma-b6r3-completed-elsewhere');
    const linkage = { initiative: { uuid: initiativeUuid }, task_uuid: taskUuid, authorized_by: 'host-a' };

    // Claim, then admit WITH linkage already attached (SPEC-003 B6 round-2 defect B, Option 1)
    // but never run this execution's own admission-time `claimed -> in_progress` transition — the
    // crash window that leaves `neverEnteredInProgress` true for THIS execution below.
    const claimed = initiativeRuntime.execute({
      operation: 'initiative_task_claim', input: { uuid: taskUuid }, expected_revision: 0, provenance,
    }) as { revision: number };
    store.admit('other-actor-completes', 'investigate', '/repo', process.pid, linkage);

    // Another actor completes the Task via a DIFFERENT execution entirely, in the gap between
    // this row's admission and its replay.
    const inProgress = initiativeRuntime.execute({
      operation: 'initiative_task_execution',
      input: { uuid: taskUuid, execution_ref: 'other-exec', transition: 'in_progress' },
      expected_revision: claimed.revision, provenance,
    }) as { revision: number };
    initiativeRuntime.execute({
      operation: 'initiative_task_execution',
      input: { uuid: taskUuid, execution_ref: 'other-exec', transition: 'completed', outcome: 'succeeded' },
      expected_revision: inProgress.revision, provenance,
    });

    // Our own execution now terminalizes (failed) — its outbox row's replay maps to `blocked`,
    // which the now-`completed` Task no longer admits.
    store.fail('other-actor-completes', JSON.stringify({ execution: { status: 'failed' } }));
    expect(store.listUnconsumedOutbox()).toHaveLength(1);

    const logLines: string[] = [];
    const linker = new InitiativeLinker({ store, initiativeRuntime, log: (line) => logLines.push(line) });
    linker.replayOutbox();

    // Reconciliation-complete, not stuck: the row is consumed and the divergence is logged.
    expect(store.listUnconsumedOutbox()).toEqual([]);
    expect(
      logLines.some((l) => l.includes('event=initiative_link_task_diverged') && l.includes('other-actor-completes')),
    ).toBe(true);

    // The Task the OTHER actor completed is untouched by this rejected mutation.
    const liveTask = initiativeRuntime.execute({ operation: 'initiative_task_get', input: { uuid: taskUuid } }) as {
      status: string; outcome: string | null; executionRefs: string[];
    };
    expect(liveTask.status).toBe('completed');
    expect(liveTask.outcome).toBe('succeeded');
    expect(liveTask.executionRefs).toEqual(['other-exec']);

    // Evidence for THIS execution's own history is still durable — the outbox's real job.
    const evidence = initiativeRuntime.execute({
      operation: 'evidence_list', input: { initiative_id: initiativeUuid },
    }) as Array<{ kind: string; locator: string }>;
    expect(evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'execution_result', locator: 'execution://other-actor-completes' })]),
    );
  });

  // Round-3 finding 2: if the tolerant ref-only append lands but `markOutboxConsumed` fails or
  // crashes, a retry sees `executionRefs.includes(executionId)` true, takes the full-transition
  // branch (a different idempotency key), and throws `invalid_task_transition` on a Task that
  // never actually reached `in_progress` — previously retried forever.
  it('a ref-append-landed-but-not-consumed retry: next replay consumes the row without changing the claimed Task\'s status', () => {
    const { initiativeUuid, taskUuid } = seedInitiativeAndTask('mma-b6r3-ref-landed-not-consumed');
    const linkage = { initiative: { uuid: initiativeUuid }, task_uuid: taskUuid, authorized_by: 'host-a' };

    const claimed = initiativeRuntime.execute({
      operation: 'initiative_task_claim', input: { uuid: taskUuid }, expected_revision: 0, provenance,
    }) as { revision: number };
    store.admit('ref-landed-not-consumed', 'investigate', '/repo', process.pid, linkage);

    // Simulate a PRIOR replay attempt that landed the tolerant ref-only append (Step 5's
    // `neverEnteredInProgress` branch) but crashed before `markOutboxConsumed` ran: the Task
    // stays `claimed` — its own in_progress transition never happened — yet the execution ref is
    // already recorded.
    initiativeRuntime.execute({
      operation: 'initiative_task_execution',
      input: { uuid: taskUuid, execution_ref: 'ref-landed-not-consumed' },
      expected_revision: claimed.revision, provenance,
    });

    store.complete('ref-landed-not-consumed', JSON.stringify({ execution: { status: 'completed' } }));
    expect(store.listUnconsumedOutbox()).toHaveLength(1);

    const logLines: string[] = [];
    const linker = new InitiativeLinker({ store, initiativeRuntime, log: (line) => logLines.push(line) });
    linker.replayOutbox();

    expect(store.listUnconsumedOutbox()).toEqual([]);
    expect(
      logLines.some((l) => l.includes('event=initiative_link_task_diverged') && l.includes('ref-landed-not-consumed')),
    ).toBe(true);

    // The claimed Task's status is untouched — the full-transition attempt (`claimed -> completed`
    // is not a listed FR-9 transition) was rejected and the row was consumed instead of retried.
    const liveTask = initiativeRuntime.execute({ operation: 'initiative_task_get', input: { uuid: taskUuid } }) as {
      status: string; claimed_by: string | null; executionRefs: string[];
    };
    expect(liveTask.status).toBe('claimed');
    expect(liveTask.claimed_by).toBe('host-a');
    expect(liveTask.executionRefs).toEqual(['ref-landed-not-consumed']);

    const evidence = initiativeRuntime.execute({
      operation: 'evidence_list', input: { initiative_id: initiativeUuid },
    }) as Array<{ kind: string; locator: string }>;
    expect(evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'execution_result', locator: 'execution://ref-landed-not-consumed' })]),
    );
  });
});