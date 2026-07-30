// ExecutionStore — durable execution records (SQLite). Answers "what
// happened": task IDs and terminal results survive a daemon restart, and
// previously-active executions are reconciled to `interrupted` on boot.
// Execution is never resumed — the caller retries with a NEW task.
//
// The in-memory TaskRegistry stays the hot-path index for live entries; this
// store is the durable record behind it. State machine (CAS-enforced in SQL —
// a terminal row is never overwritten):
//
//   pending ──► complete | failed | cancelled          (runtime, live daemon)
//   pending ──► interrupted                            (boot reconciliation,
//                                                       owning daemon dead)
//
// Deliberately uses its OWN DatabaseSync connection and file — never
// JournalIndexStore's (its single connection already hit "cannot start a
// transaction within a transaction" under concurrent use).

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type StoredExecutionState = 'pending' | 'complete' | 'failed' | 'cancelled' | 'interrupted';

export interface ExecutionRecord {
  id: string;
  type: string;
  cwd: string;
  state: StoredExecutionState;
  createdAt: number;
  updatedAt: number;
  terminalAt: number | null;
  /** Terminal rows are pruned once now > expiresAt (mirrors the registry TTL). */
  expiresAt: number | null;
  cancellationRequestedAt: number | null;
  /** Terminal result envelope (JSON), exactly what GET /task/:id returns. */
  resultJson: string | null;
  /** Pid of the daemon that owns/owned this execution — reconciliation only
   *  touches rows whose owning daemon is no longer alive. */
  daemonPid: number;
  /** Leader pid of the detached codex worker process group, when one spawned.
   *  POSIX: also the process-group id (detached ⇒ group leader). Used by boot
   *  reconciliation to terminate stragglers that outlived a crashed daemon. */
  workerPid: number | null;
}

interface Row {
  id: string;
  type: string;
  cwd: string;
  state: string;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
  expires_at: number | null;
  cancellation_requested_at: number | null;
  result_json: string | null;
  daemon_pid: number;
  worker_pid: number | null;
}

function toRecord(r: Row): ExecutionRecord {
  return {
    id: r.id,
    type: r.type,
    cwd: r.cwd,
    state: r.state as StoredExecutionState,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    terminalAt: r.terminal_at,
    expiresAt: r.expires_at,
    cancellationRequestedAt: r.cancellation_requested_at,
    resultJson: r.result_json,
    daemonPid: r.daemon_pid,
    workerPid: r.worker_pid,
  };
}

export class ExecutionStore {
  private readonly db: DatabaseSync;
  private readonly ttlMs: number;

  constructor(opts: { dbPath: string; ttlMs: number }) {
    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = new DatabaseSync(opts.dbPath);
    this.ttlMs = opts.ttlMs;
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        cwd TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        terminal_at INTEGER,
        expires_at INTEGER,
        cancellation_requested_at INTEGER,
        result_json TEXT,
        daemon_pid INTEGER NOT NULL,
        worker_pid INTEGER
      )
    `);
  }

  /** Persist the admission record. Called BEFORE the handle is returned to the
   *  caller, so a handle that exists is always a handle that survives. */
  admit(id: string, type: string, cwd: string, daemonPid: number): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO executions (id, type, cwd, state, created_at, updated_at, daemon_pid)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, type, cwd, now, now, daemonPid);
  }

  /** Record the detached worker's process-group leader pid (codex). Only
   *  meaningful while pending — a terminal row's worker is already reaped. */
  recordWorkerPid(id: string, workerPid: number): void {
    this.db.prepare(`
      UPDATE executions SET worker_pid = ?, updated_at = ?
      WHERE id = ? AND state = 'pending'
    `).run(workerPid, Date.now(), id);
  }

  /** Set the cancellation-requested flag (not a state transition). Idempotent;
   *  a terminal row is untouched. */
  requestCancel(id: string): void {
    this.db.prepare(`
      UPDATE executions SET cancellation_requested_at = ?, updated_at = ?
      WHERE id = ? AND state = 'pending' AND cancellation_requested_at IS NULL
    `).run(Date.now(), Date.now(), id);
  }

  /** Terminal CAS: only a pending row transitions; a row that already reached
   *  a terminal state is never overwritten (first writer wins). */
  private terminalize(id: string, state: 'complete' | 'failed' | 'cancelled' | 'interrupted', resultJson: string): boolean {
    const now = Date.now();
    const res = this.db.prepare(`
      UPDATE executions
      SET state = ?, result_json = ?, terminal_at = ?, expires_at = ?, updated_at = ?
      WHERE id = ? AND state = 'pending'
    `).run(state, resultJson, now, now + this.ttlMs, now, id);
    return res.changes > 0;
  }

  complete(id: string, resultJson: string): boolean { return this.terminalize(id, 'complete', resultJson); }
  fail(id: string, resultJson: string): boolean { return this.terminalize(id, 'failed', resultJson); }
  cancel(id: string, resultJson: string): boolean { return this.terminalize(id, 'cancelled', resultJson); }

  get(id: string): ExecutionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Non-terminal rows owned by daemons other than `ownPid`. Boot-time input
   *  to reconciliation: rows whose owning daemon is dead get fenced +
   *  interrupted; rows owned by a still-alive daemon are left alone. */
  stalePending(ownPid: number): ExecutionRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM executions WHERE state = 'pending' AND daemon_pid != ?`,
    ).all(ownPid) as unknown as Row[];
    return rows.map(toRecord);
  }

  /** Reconciliation transition: pending → interrupted (CAS, same discipline). */
  interrupt(id: string, resultJson: string): boolean { return this.terminalize(id, 'interrupted', resultJson); }

  /** Drop terminal rows past their retention TTL. Returns rows removed. */
  pruneExpired(now = Date.now()): number {
    const res = this.db.prepare(
      `DELETE FROM executions WHERE terminal_at IS NOT NULL AND expires_at < ?`,
    ).run(now);
    return Number(res.changes);
  }

  close(): void {
    this.db.close();
  }
}
