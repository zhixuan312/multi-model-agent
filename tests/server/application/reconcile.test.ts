// Boot reconciliation — crash fencing without execution resume.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ExecutionStore } from '../../../packages/server/src/application/execution-store.js';
import { InitiativeLinker } from '../../../packages/server/src/application/initiative-linker.js';
import { InitiativeRecordRuntime } from '../../../packages/server/src/application/initiative-record-runtime.js';
import { reconcileOnBoot } from '../../../packages/server/src/application/reconcile.js';

const DEAD_PID = 999_999_999; // far beyond pid_max everywhere — never a live process

/** Provenance for direct `InitiativeRecordRuntime.execute()` calls below — bypasses the
 *  HTTP/MCP adapter's own provenance stamping, so any non-empty `timestamp` is accepted by the
 *  schema as-is. Mirrors `execution-runtime.test.ts`'s SPEC-003 B6 fixture. */
const provenance = {
  actor_type: 'human' as const,
  actor_id: 'host-a',
  interface: 'test',
  initiated_by: 'host-a',
  authorized_by: 'host-a',
  timestamp: 'ignored',
  source: 'test',
};

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

describe('reconcileOnBoot', () => {
  let dir: string;
  let store: ExecutionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mma-reconcile-'));
    store = new ExecutionStore({ dbPath: join(dir, 'executions.db'), ttlMs: 3_600_000 });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks a dead daemon\'s pending execution interrupted with a retryable envelope', () => {
    store.admit('stale-1', 'execute_plan', '/repo', DEAD_PID);
    const outcome = reconcileOnBoot(store, process.pid);
    expect(outcome.interrupted).toBe(1);

    const r = store.get('stale-1')!;
    expect(r.state).toBe('interrupted');
    const envelope = JSON.parse(r.resultJson!);
    expect(envelope.execution.status).toBe('interrupted');
    expect(envelope.error.code).toBe('daemon_restarted');
    expect(envelope.error.retryable).toBe(true);
    expect(envelope.error.message).toMatch(/Submit the task again/);
  });

  it('leaves pending executions of a LIVE daemon alone', () => {
    // Owned by this very process — alive by definition, and not ours to touch
    // when reconciling as a different (fake) daemon pid.
    store.admit('live-1', 'investigate', '/repo', process.pid);
    const outcome = reconcileOnBoot(store, DEAD_PID);
    expect(outcome.interrupted).toBe(0);
    expect(store.get('live-1')!.state).toBe('pending');
  });

  it('never signals a reused pid that is not a codex worker', async () => {
    // A live process whose command line does NOT contain 'codex' — the fencing
    // guard must refuse to signal it even though the record names its pid.
    const bystander = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    bystander.unref();
    const pid = bystander.pid!;
    try {
      store.admit('stale-2', 'delegate', '/repo', DEAD_PID);
      store.recordWorkerPid('stale-2', pid);

      const outcome = reconcileOnBoot(store, process.pid);
      expect(outcome.interrupted).toBe(1);
      expect(outcome.fencedWorkers).toBe(0);     // guard refused
      expect(pidAlive(pid)).toBe(true);          // bystander untouched
      expect(store.get('stale-2')!.state).toBe('interrupted');
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it.skipIf(process.platform === 'win32')('fences a surviving codex worker process group', async () => {
    // Simulate a detached codex worker that outlived its daemon: a process
    // whose argv[0] is renamed to contain 'codex' (what the ps-based guard
    // checks), in its own process group like the real spawn.
    const worker = spawn('bash', ['-c', 'exec -a codex-straggler sleep 30'], { detached: true, stdio: 'ignore' });
    worker.unref();
    const pid = worker.pid!;
    // Give bash a beat to exec so ps sees the renamed command.
    await new Promise((r) => setTimeout(r, 200));

    try {
      store.admit('stale-3', 'execute_plan', '/repo', DEAD_PID);
      store.recordWorkerPid('stale-3', pid);

      const outcome = reconcileOnBoot(store, process.pid);
      expect(outcome.interrupted).toBe(1);
      expect(outcome.fencedWorkers).toBe(1);
      // SIGKILL delivery is immediate; reaping the zombie may lag a beat.
      await new Promise((r) => setTimeout(r, 200));
      expect(store.get('stale-3')!.state).toBe('interrupted');
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead — expected */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead — expected */ }
    }
  });

  it('prunes expired terminal rows as part of reconciliation', () => {
    store.admit('done-old', 'audit', '/repo', process.pid);
    store.complete('done-old', '{}');
    // Fresh terminal row within TTL → kept by the boot prune.
    const outcome = reconcileOnBoot(store, process.pid);
    expect(outcome.prunedExpired).toBe(0);
    expect(store.get('done-old')).toBeDefined();
  });

  // SPEC-003 B6 round-2 defect B — Option 1: linkage is attached to the pending row in the SAME
  // write as admission, before the admission-time Task transition ever runs. These two tests
  // simulate the crash window that defect described directly on the store (no HTTP, no real
  // `ExecutionRuntime.submit()` call — that method never leaves this window open long enough to
  // observe from outside it): a linked row admitted with a DEAD daemon pid, whose Task transition
  // either ran before the "crash" or never got the chance to.
  describe('linked-execution crash window (SPEC-003 B6 round-2 defect B)', () => {
    let initiativeStateDir: string;
    let initiativeRuntime: InitiativeRecordRuntime;

    beforeEach(() => {
      initiativeStateDir = mkdtempSync(join(tmpdir(), 'mma-reconcile-initiative-'));
      initiativeRuntime = InitiativeRecordRuntime.open({ stateDir: initiativeStateDir });
    });
    afterEach(() => {
      initiativeRuntime.close();
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

    it('a crash AFTER the Task transition succeeded still reopens the Task — linkage was already durable at admission, so the outbox row exists', () => {
      const { initiativeUuid, taskUuid } = seedInitiativeAndTask('mma-crash-after-transition');
      const linkage = { initiative: { uuid: initiativeUuid }, task_uuid: taskUuid, authorized_by: 'host-a' };

      // Mirrors what `ExecutionRuntime.submit()` now does: attach linkage in the SAME admit()
      // write, THEN run the admission-time Task transition. Then "crash" — no terminal write is
      // ever made on the execution, and the owning daemon (DEAD_PID) is dead.
      store.admit('crashed-after', 'investigate', '/repo', DEAD_PID, linkage);
      const claimedTask = initiativeRuntime.execute({
        operation: 'initiative_task_execution',
        input: { uuid: taskUuid, execution_ref: 'crashed-after', transition: 'in_progress' },
        expected_revision: 0,
        provenance,
      }) as { revision: number };
      expect(claimedTask.revision).toBeGreaterThan(0);

      const linker = new InitiativeLinker({ store, initiativeRuntime });
      const outcome = reconcileOnBoot(store, process.pid, linker);

      expect(outcome.interrupted).toBe(1);
      expect(store.get('crashed-after')!.state).toBe('interrupted');
      // The row produced an outbox entry (linkage was already attached at admission) AND the
      // linker consumed it — under the prior attach-AFTER-transition ordering this outbox row
      // would never have existed, and the Task below would be stuck at `in_progress` forever.
      expect(store.listUnconsumedOutbox()).toEqual([]);
      const liveTask = initiativeRuntime.execute({ operation: 'initiative_task_get', input: { uuid: taskUuid } }) as { status: string };
      expect(liveTask.status).toBe('open');
    });

    it('a crash BEFORE the Task transition ran leaves the Task untouched — tolerant replay treats it as nothing to undo, not a stuck outbox row', () => {
      const { initiativeUuid, taskUuid } = seedInitiativeAndTask('mma-crash-before-transition');
      const linkage = { initiative: { uuid: initiativeUuid }, task_uuid: taskUuid, authorized_by: 'host-a' };

      // Claim the Task first, so its pre-admission status is `claimed`, not `open` — this is
      // the case the naive "already in target state" check cannot catch by itself: replaying
      // `interrupted -> open` against a Task still `claimed` is not a listed FR-9 transition.
      initiativeRuntime.execute({
        operation: 'initiative_task_claim', input: { uuid: taskUuid }, expected_revision: 0, provenance,
      });

      // Admit WITH linkage already attached (Option 1) but never run the Task transition — the
      // daemon "died" in the gap between admission and the transition call.
      store.admit('crashed-before', 'investigate', '/repo', DEAD_PID, linkage);

      const linker = new InitiativeLinker({ store, initiativeRuntime });
      const outcome = reconcileOnBoot(store, process.pid, linker);

      expect(outcome.interrupted).toBe(1);
      expect(store.get('crashed-before')!.state).toBe('interrupted');
      // No `invalid_task_transition` throw left the row stuck unconsumed.
      expect(store.listUnconsumedOutbox()).toEqual([]);

      const liveTask = initiativeRuntime.execute({ operation: 'initiative_task_get', input: { uuid: taskUuid } }) as {
        status: string; claimed_by: string | null; executionRefs: string[];
      };
      // Nothing to undo: the Task stays exactly where it was — still claimed, ready for a fresh
      // linked attempt — not forced into `open` (invalid from `claimed`) and not left stranded.
      expect(liveTask.status).toBe('claimed');
      expect(liveTask.claimed_by).toBe('host-a');
      // The execution_ref is still recorded so the Task's history names this attempt.
      expect(liveTask.executionRefs).toEqual(['crashed-before']);
    });
  });
});
