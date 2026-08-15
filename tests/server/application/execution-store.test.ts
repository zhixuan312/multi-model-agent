// ExecutionStore — durable record CRUD + CAS transition discipline.
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionStore } from '../../../packages/server/src/application/execution-store.js';

const TTL = 3_600_000;

describe('ExecutionStore', () => {
  let dir: string;
  let store: ExecutionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mma-exec-store-'));
    store = new ExecutionStore({ dbPath: join(dir, 'executions.db'), ttlMs: TTL });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('admit persists a pending record before any handle exists', () => {
    store.admit('t1', 'investigate', '/repo', process.pid);
    const r = store.get('t1')!;
    expect(r.state).toBe('pending');
    expect(r.type).toBe('investigate');
    expect(r.cwd).toBe('/repo');
    expect(r.daemonPid).toBe(process.pid);
    expect(r.resultJson).toBeNull();
    expect(r.terminalAt).toBeNull();
  });

  it('persists the resolved Method on the admission row before terminalization', () => {
    store.admit('t1', 'review', '/repo', process.pid, undefined, 'software-change@1');
    expect(store.get('t1')!.method).toBe('software-change@1');
  });

  it('records survive reopening the database (restart survival)', () => {
    store.admit('t1', 'audit', '/repo', process.pid);
    store.complete('t1', '{"task":{"status":"done"}}');
    store.close();

    store = new ExecutionStore({ dbPath: join(dir, 'executions.db'), ttlMs: TTL });
    const r = store.get('t1')!;
    expect(r.state).toBe('complete');
    expect(JSON.parse(r.resultJson!)).toEqual({ task: { status: 'done' } });
    expect(existsSync(join(dir, 'executions.db'))).toBe(true);
  });

  it('terminal CAS: first writer wins, a terminal row is never overwritten', () => {
    store.admit('t1', 'delegate', '/repo', process.pid);
    expect(store.complete('t1', '{"won":"complete"}')).toBe(true);
    // Late cancel/fail/interrupt all lose the race.
    expect(store.cancel('t1', '{"late":"cancel"}')).toBe(false);
    expect(store.fail('t1', '{"late":"fail"}')).toBe(false);
    expect(store.interrupt('t1', '{"late":"interrupt"}')).toBe(false);
    expect(JSON.parse(store.get('t1')!.resultJson!)).toEqual({ won: 'complete' });
    expect(store.get('t1')!.state).toBe('complete');
  });

  it('requestCancel sets the flag once, only while pending', () => {
    store.admit('t1', 'review', '/repo', process.pid);
    store.requestCancel('t1');
    const first = store.get('t1')!.cancellationRequestedAt;
    expect(first).not.toBeNull();
    store.requestCancel('t1'); // idempotent — timestamp unchanged
    expect(store.get('t1')!.cancellationRequestedAt).toBe(first);

    store.cancel('t1', '{"status":"cancelled"}');
    store.requestCancel('t1'); // terminal row untouched
    expect(store.get('t1')!.state).toBe('cancelled');
  });

  it('stalePending excludes rows owned by the asking daemon', () => {
    store.admit('mine', 'investigate', '/repo', process.pid);
    store.admit('theirs', 'investigate', '/repo', 999_999_999);
    const stale = store.stalePending(process.pid);
    expect(stale.map((r) => r.id)).toEqual(['theirs']);
  });

  it('pruneExpired drops only terminal rows past their TTL', () => {
    store.admit('old-done', 'audit', '/repo', process.pid);
    store.complete('old-done', '{}');
    store.admit('still-running', 'audit', '/repo', process.pid);

    // Terminal row not yet expired → kept.
    expect(store.pruneExpired(Date.now())).toBe(0);
    // Far future: terminal row expired → dropped; pending row NEVER pruned.
    expect(store.pruneExpired(Date.now() + TTL + 60_000)).toBe(1);
    expect(store.get('old-done')).toBeUndefined();
    expect(store.get('still-running')).toBeDefined();
  });

  it('pruneExpired bounds CONSUMED outbox rows but never unconsumed ones', () => {
    // `listUnconsumedOutbox` is the outbox's only reader and it filters consumed rows out, so a
    // consumed row is read by nothing — yet nothing deleted them either, and every linked
    // Execution left one permanent row in a file that is never vacuumed.
    const linkage = { initiative: { uuid: 'i-1' }, authorized_by: 'tester' };
    store.admit('linked-consumed', 'delegate', '/repo', process.pid, linkage);
    store.complete('linked-consumed', '{}');
    store.admit('linked-pending-replay', 'delegate', '/repo', process.pid, linkage);
    store.complete('linked-pending-replay', '{}');

    expect(store.listUnconsumedOutbox().map((r) => r.executionId).sort())
      .toEqual(['linked-consumed', 'linked-pending-replay']);
    expect(store.markOutboxConsumed('linked-consumed')).toBe(true);

    store.pruneExpired(Date.now() + TTL + 60_000);

    // The consumed row is gone; the one still awaiting replay survives, however old — that row IS
    // the durable promise that a linked Initiative still needs its terminal replay, and its
    // payload carries everything the replay needs even after its execution row is pruned.
    expect(store.listUnconsumedOutbox().map((r) => r.executionId)).toEqual(['linked-pending-replay']);

    // Counted from the FILE, not through the store's own readers. `listUnconsumedOutbox` filters
    // consumed rows out and `markOutboxConsumed` returns false for an already-consumed row, so
    // both answer identically whether the row was deleted or merely marked — an earlier version of
    // this test asserted through them and passed with the pruning removed.
    store.close();
    const raw = new DatabaseSync(join(dir, 'executions.db'));
    const ids = (raw.prepare('SELECT execution_id FROM outbox').all() as Array<{ execution_id: string }>)
      .map((r) => r.execution_id);
    raw.close();
    expect(ids, 'the consumed row must be gone from the table, not just flagged').toEqual(['linked-pending-replay']);
  });

  it('recordWorkerPid attaches only to pending rows', () => {
    store.admit('t1', 'delegate', '/repo', process.pid);
    store.recordWorkerPid('t1', 4242);
    expect(store.get('t1')!.workerPid).toBe(4242);

    store.complete('t1', '{}');
    store.recordWorkerPid('t1', 9999); // terminal — ignored
    expect(store.get('t1')!.workerPid).toBe(4242);
  });
});

describe('ExecutionStore after close', () => {
  /**
   * Executions are detached async work, so one can still be finishing when the daemon (or a
   * test harness) shuts the store down. Writing to a closed DatabaseSync throws
   * ERR_INVALID_STATE from a promise nobody awaits — an unhandled rejection that takes the
   * process down on a path where there is nothing left to persist to anyway.
   */
  it('turns every operation into a no-op instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-store-closed-'));
    const store = new ExecutionStore({ dbPath: join(dir, 'executions.db'), ttlMs: TTL });
    store.admit('t1', 'delegate', '/tmp/x', process.pid);
    store.close();

    expect(() => store.admit('t2', 'delegate', '/tmp/x', process.pid)).not.toThrow();
    expect(() => store.recordWorkerPid('t1', 123)).not.toThrow();
    expect(() => store.requestCancel('t1')).not.toThrow();
    expect(store.complete('t1', '{}')).toBe(false);
    expect(store.fail('t1', '{}')).toBe(false);
    expect(store.cancel('t1', '{}')).toBe(false);
    expect(store.interrupt('t1', '{}')).toBe(false);
    expect(store.get('t1')).toBeUndefined();
    expect(store.stalePending(process.pid)).toEqual([]);
    expect(store.pruneExpired()).toBe(0);
    expect(() => store.close()).not.toThrow();   // idempotent

    rmSync(dir, { recursive: true, force: true });
  });
});
