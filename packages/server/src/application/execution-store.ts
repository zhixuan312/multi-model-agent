// ExecutionStore — durable execution records (SQLite). Answers "what
// happened": task IDs and terminal results survive a daemon restart, and
// previously-active executions are reconciled to `interrupted` on boot.
// Execution is never resumed — the caller retries with a NEW task.
//
// The in-memory ExecutionRegistry stays the hot-path index for live entries; this
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

type StoredExecutionState = 'pending' | 'complete' | 'failed' | 'cancelled' | 'interrupted';

/** Validated Initiative selector + optional Task reference + linkage authorization, supplied at
 *  admission for a linked Execution. Persisted on the execution row so the terminal CAS can
 *  read it back without the caller re-supplying it (and so it survives a daemon restart —
 *  boot reconciliation's `interrupt()` call goes through the same terminal path). Shape mirrors
 *  the Initiative selector union (`{ uuid }` or `{ human_key }`); kept structurally loose here
 *  because the Zod-validated wire schema lives at the transport boundary (Task I-6), not in
 *  this durable store. `task_uuid` is OPTIONAL (frozen interface, AC-1.1): its absence marks
 *  Initiative-only linkage — there is no Task to scope writes to, check membership against, or
 *  transition. */
export interface ExecutionLinkage {
  initiative: { uuid: string } | { human_key: string };
  task_uuid?: string;
  authorized_by: string;
}

/** One outbox row: durable proof that a linked terminal Execution needs an Initiative-side
 *  replay (Task I-5's `InitiativeLinker`). `payload` bundles the linkage plus the terminal
 *  envelope so replay never has to re-read `executions` for it. */
export interface OutboxRecord {
  executionId: string;
  payload: unknown;
  createdAt: number;
  consumedAt: number | null;
}

interface OutboxRow {
  execution_id: string;
  payload: string;
  created_at: number;
  consumed_at: number | null;
}

/** Terminal envelopes are always `JSON.stringify`-produced by callers (never raw LLM text —
 *  that extraction lives in `result-shape.ts#tryParseJson` and is a different concern). Falls
 *  back to the raw string so a malformed caller-supplied value never aborts the terminal
 *  transaction the outbox row is written inside. */
function parseResultJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

function toOutboxRecord(r: OutboxRow): OutboxRecord {
  return {
    executionId: r.execution_id,
    payload: JSON.parse(r.payload),
    createdAt: r.created_at,
    consumedAt: r.consumed_at,
  };
}

interface ExecutionRecord {
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
  /** Terminal result envelope (JSON), exactly what GET /execution/:id returns. */
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
  /** Set by close(). Executions are detached async work, so one can still be finishing when
   *  the daemon (or a test harness) shuts the store down. Writing to a closed DatabaseSync
   *  throws ERR_INVALID_STATE from a promise nobody awaits — an unhandled rejection that
   *  crashes the process on a path where there is nothing left to persist to anyway. After
   *  close, durable writes become no-ops; every other DB error still propagates. */
  private closed = false;

  constructor(opts: { dbPath: string; ttlMs: number }) {
    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = new DatabaseSync(opts.dbPath);
    this.ttlMs = opts.ttlMs;
    this.db.exec('PRAGMA journal_mode = WAL');
    // Wait for a contended lock instead of failing instantly. Without this, SQLite's default
    // busy timeout is ZERO: the first concurrent writer to arrive gets SQLITE_BUSY immediately.
    //
    // Two daemons genuinely overlap on this file. `mma restart` starts the replacement while the
    // outgoing daemon is still draining in-flight requests, and boot reconciliation reads and
    // writes the same table. A zero timeout turns that ordinary overlap into a failed admission —
    // and admission is the one write that must not be lost, because the contract of this store is
    // that a handle returned to a caller always survives. The journal index has waited 5000 ms
    // since it was written; this store simply never gained the same setting.
    this.db.exec('PRAGMA busy_timeout = 5000');
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
        worker_pid INTEGER,
        linkage_json TEXT
      )
    `);
    // `CREATE TABLE IF NOT EXISTS` does not apply new columns to the database
    // created by pre-outbox daemons. Keep this migration on the same schema-open
    // path so an upgraded daemon can admit linked executions into its existing
    // state directory.
    const executionColumns = this.db.prepare('PRAGMA table_info(executions)').all() as Array<{ name: string }>;
    if (!executionColumns.some((column) => column.name === 'linkage_json')) {
      this.db.exec('ALTER TABLE executions ADD COLUMN linkage_json TEXT');
    }
    // Outbox: exactly one row per LINKED execution, written in the same transaction as its
    // terminal CAS (see `terminalize`). No retention/deletion behavior — Task I-5's
    // InitiativeLinker consumes rows via `listUnconsumedOutbox` / `markOutboxConsumed`.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER
      )
    `);
  }

  /** Persist the admission record. Called BEFORE the handle is returned to the
   *  caller, so a handle that exists is always a handle that survives.
   *
   *  `linkage`, when supplied, marks this Execution as linked to an Initiative Task. It is
   *  persisted here (not held in memory) so the terminal CAS in `terminalize` — reached later,
   *  possibly after a daemon restart via boot reconciliation's `interrupt()` — can read it back
   *  without the caller re-supplying it. Omitting it (the existing unlinked call shape) means
   *  the terminal write for this execution creates no outbox row. */
  admit(id: string, type: string, cwd: string, daemonPid: number, linkage?: ExecutionLinkage): void {
    if (this.closed) return;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO executions (id, type, cwd, state, created_at, updated_at, daemon_pid, linkage_json)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(id, type, cwd, now, now, daemonPid, linkage ? JSON.stringify(linkage) : null);
  }

  /** Attaches a linkage to an already-admitted row (SPEC-003 B6 defect 3). Used when the Task
   *  transition that authorizes a linked Execution runs AFTER `admit()`: admitting WITHOUT
   *  linkage first means a `register`/`admit` failure has nothing to compensate on the Task side
   *  (the transition hasn't run yet), and attaching linkage only once the transition itself
   *  succeeds means a request whose transition fails terminalizes with no `linkage_json` — so
   *  `terminalize()` produces no outbox row claiming a Task transition that never happened.
   *  No-op on a row that already reached a terminal state. */
  attachLinkage(id: string, linkage: ExecutionLinkage): void {
    if (this.closed) return;
    this.db.prepare(`
      UPDATE executions SET linkage_json = ?, updated_at = ?
      WHERE id = ? AND state = 'pending'
    `).run(JSON.stringify(linkage), Date.now(), id);
  }

  /** Record the detached worker's process-group leader pid (codex). Only
   *  meaningful while pending — a terminal row's worker is already reaped. */
  recordWorkerPid(id: string, workerPid: number): void {
    if (this.closed) return;
    this.db.prepare(`
      UPDATE executions SET worker_pid = ?, updated_at = ?
      WHERE id = ? AND state = 'pending'
    `).run(workerPid, Date.now(), id);
  }

  /** Set the cancellation-requested flag (not a state transition). Idempotent;
   *  a terminal row is untouched. */
  requestCancel(id: string): void {
    if (this.closed) return;
    this.db.prepare(`
      UPDATE executions SET cancellation_requested_at = ?, updated_at = ?
      WHERE id = ? AND state = 'pending' AND cancellation_requested_at IS NULL
    `).run(Date.now(), Date.now(), id);
  }

  /** Terminal CAS: only a pending row transitions; a row that already reached
   *  a terminal state is never overwritten (first writer wins).
   *
   *  Linked executions (admitted with `linkage`) get exactly one outbox row inserted in the
   *  SAME transaction as the terminal update — a CAS that loses the race (row already terminal)
   *  inserts none, and a SQLite failure rolls back both writes. Unlinked executions are
   *  unaffected: no linkage_json means no outbox row, same result as before this table existed. */
  private terminalize(id: string, state: 'complete' | 'failed' | 'cancelled' | 'interrupted', resultJson: string): boolean {
    if (this.closed) return false;
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pending = this.db.prepare(
        `SELECT linkage_json FROM executions WHERE id = ? AND state = 'pending'`,
      ).get(id) as { linkage_json: string | null } | undefined;

      const res = this.db.prepare(`
        UPDATE executions
        SET state = ?, result_json = ?, terminal_at = ?, expires_at = ?, updated_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(state, resultJson, now, now + this.ttlMs, now, id);
      const won = res.changes > 0;

      if (won && pending?.linkage_json) {
        const payload = {
          linkage: JSON.parse(pending.linkage_json) as ExecutionLinkage,
          execution_id: id,
          state,
          terminal_envelope: parseResultJson(resultJson),
        };
        this.db.prepare(`
          INSERT INTO outbox (execution_id, payload, created_at, consumed_at)
          VALUES (?, ?, ?, NULL)
        `).run(id, JSON.stringify(payload), now);
      }

      this.db.exec('COMMIT');
      return won;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already be aborted by the failure above — nothing more to undo.
      }
      throw error;
    }
  }

  complete(id: string, resultJson: string): boolean { return this.terminalize(id, 'complete', resultJson); }
  fail(id: string, resultJson: string): boolean { return this.terminalize(id, 'failed', resultJson); }
  cancel(id: string, resultJson: string): boolean { return this.terminalize(id, 'cancelled', resultJson); }

  get(id: string): ExecutionRecord | undefined {
    if (this.closed) return undefined;
    const row = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Non-terminal rows owned by daemons other than `ownPid`. Boot-time input
   *  to reconciliation: rows whose owning daemon is dead get fenced +
   *  interrupted; rows owned by a still-alive daemon are left alone. */
  stalePending(ownPid: number): ExecutionRecord[] {
    if (this.closed) return [];
    const rows = this.db.prepare(
      `SELECT * FROM executions WHERE state = 'pending' AND daemon_pid != ?`,
    ).all(ownPid) as unknown as Row[];
    return rows.map(toRecord);
  }

  /** Reconciliation transition: pending → interrupted (CAS, same discipline). */
  interrupt(id: string, resultJson: string): boolean { return this.terminalize(id, 'interrupted', resultJson); }

  /**
   * Rows marked `interrupted` at or after `since`.
   *
   * Exists for `mma restart` / `mma update`, which must tell the user what the
   * restart just destroyed. That report has to happen at restart time: terminal
   * rows expire after `batchTtlMs` (one hour by default) and are pruned at the
   * next boot, so a user who thinks to look later may find nothing.
   *
   * It returns identity only — id, type, cwd — because that is all the table
   * holds. Admission never stored the prompt, target or options
   * (`application/execution-runtime.ts`), so nothing here can rebuild the
   * request. The caller retries; MMA cannot.
   */
  interruptedSince(since: number): ExecutionRecord[] {
    if (this.closed) return [];
    const rows = this.db.prepare(
      `SELECT * FROM executions WHERE state = 'interrupted' AND terminal_at >= ? ORDER BY terminal_at ASC`,
    ).all(since) as unknown as Row[];
    return rows.map(toRecord);
  }

  /** Outbox rows not yet consumed, oldest first. Task I-5's `InitiativeLinker` replays these —
   *  at boot (after fencing) and after every later terminal write. No retention/deletion
   *  behavior here: rows persist until `markOutboxConsumed` marks them, and are never pruned. */
  listUnconsumedOutbox(): OutboxRecord[] {
    if (this.closed) return [];
    const rows = this.db.prepare(
      `SELECT * FROM outbox WHERE consumed_at IS NULL ORDER BY created_at ASC`,
    ).all() as unknown as OutboxRow[];
    return rows.map(toOutboxRecord);
  }

  /** Conditional consumed marker: only an unconsumed row transitions (idempotent — a replay
   *  that lands after another replay already marked it does nothing and returns false). */
  markOutboxConsumed(executionId: string): boolean {
    if (this.closed) return false;
    const res = this.db.prepare(
      `UPDATE outbox SET consumed_at = ? WHERE execution_id = ? AND consumed_at IS NULL`,
    ).run(Date.now(), executionId);
    return res.changes > 0;
  }

  /** Drop terminal rows past their retention TTL. Returns rows removed. */
  pruneExpired(now = Date.now()): number {
    if (this.closed) return 0;
    const res = this.db.prepare(
      `DELETE FROM executions WHERE terminal_at IS NOT NULL AND expires_at < ?`,
    ).run(now);
    return Number(res.changes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
