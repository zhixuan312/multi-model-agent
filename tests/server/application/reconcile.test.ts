// Boot reconciliation — crash fencing without execution resume.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ExecutionStore } from '../../../packages/server/src/application/execution-store.js';
import { reconcileOnBoot } from '../../../packages/server/src/application/reconcile.js';

const DEAD_PID = 999_999_999; // far beyond pid_max everywhere — never a live process

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
    expect(envelope.task.status).toBe('interrupted');
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
});
