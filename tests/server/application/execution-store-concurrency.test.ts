import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionStore } from '../../../packages/server/src/application/execution-store.js';

/**
 * Two daemons overlap on `executions.db`, and admission must survive it.
 *
 * This file exists because of a measurement, not a hunch. Of 172 test files in this repository,
 * exactly ONE ran concurrent actors against a shared mutable resource — and it was written on the
 * same day, after a user reported a crash caused by precisely that gap. Every other test drove a
 * single actor. Real use is concurrent, so a whole class of defect could never be observed here.
 *
 * The overlap is ordinary, not exotic. `mma restart` starts the replacement daemon while the
 * outgoing one is still draining in-flight requests, and boot reconciliation reads and writes the
 * same table. Restarting is also exactly what an operator does when the daemon misbehaves, so this
 * path runs precisely when the system is already unhealthy.
 *
 * SQLite's default busy timeout is ZERO. Without an explicit `busy_timeout`, the first contended
 * writer gets SQLITE_BUSY immediately, and a lost admission breaks this store's central promise:
 * a handle returned to a caller always survives.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storePair(): { a: ExecutionStore; b: ExecutionStore; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mma-exec-store-concurrency-'));
  dirs.push(dir);
  const dbPath = join(dir, 'executions.db');
  // Two SEPARATE connections to one file — the shape of two daemons, not one daemon with two
  // callers. A single instance would serialise in-process and prove nothing about locking.
  return {
    a: new ExecutionStore({ dbPath, ttlMs: 60_000 }),
    b: new ExecutionStore({ dbPath, ttlMs: 60_000 }),
    dbPath,
  };
}

describe('execution store under two overlapping daemons', () => {
  it('admits from both connections without losing a record', () => {
    const { a, b } = storePair();
    // Interleaved, as an overlapping restart produces: the outgoing daemon is still admitting
    // while the replacement has already opened the same file.
    for (let i = 0; i < 25; i += 1) {
      a.admit(`a-${i}`, 'investigate', '/tmp/x', 1111);
      b.admit(`b-${i}`, 'investigate', '/tmp/x', 2222);
    }
    // Every admission must be readable from EITHER connection. A write that silently failed
    // would show up here as a missing record rather than as an error at write time.
    for (let i = 0; i < 25; i += 1) {
      expect(a.get(`b-${i}`), `b-${i} must be visible to connection a`).toBeTruthy();
      expect(b.get(`a-${i}`), `a-${i} must be visible to connection b`).toBeTruthy();
    }
  });

  it('does not throw when both connections write the same records concurrently', async () => {
    const { a, b } = storePair();
    const write = (store: ExecutionStore, prefix: string) => async () => {
      for (let i = 0; i < 40; i += 1) {
        store.admit(`${prefix}-${i}`, 'delegate', '/tmp/x', prefix === 'a' ? 1111 : 2222);
        // Yield so the two writers genuinely interleave rather than running to completion in turn.
        await Promise.resolve();
      }
    };
    await expect(Promise.all([write(a, 'a')(), write(b, 'b')()])).resolves.toBeDefined();
    expect(a.get('b-39')).toBeTruthy();
    expect(b.get('a-39')).toBeTruthy();
  });

  it('sets an explicit busy timeout rather than relying on the zero default', () => {
    const { a } = storePair();
    // Read the PRAGMA back off the live connection: asserting the source text would only prove
    // the line exists, not that it was applied to the handle this store actually uses.
    const [row] = (a as unknown as { db: { prepare(sql: string): { all(): unknown[] } } })
      .db.prepare('PRAGMA busy_timeout').all() as Array<Record<string, unknown>>;
    const value = Number(Object.values(row ?? {})[0]);
    expect(value, 'a zero busy timeout fails the first contended write immediately').toBeGreaterThan(0);
  });
});
