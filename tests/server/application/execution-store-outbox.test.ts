import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExecutionStore } from '../../../packages/server/src/application/execution-store.js';

describe('ExecutionStore outbox', () => {
  it('writes one unconsumed row with a linked terminal execution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-outbox-'));
    const store = new ExecutionStore({ dbPath: join(dir, 'executions.db'), ttlMs: 1000 });
    try {
      store.admit('execution-1', 'review', '/tmp', process.pid, { initiative: { uuid: 'initiative-1' }, task_uuid: 'task-1', authorized_by: 'host-a' });
      expect(store.complete('execution-1', JSON.stringify({ execution: { executionId: 'execution-1', status: 'completed' } }))).toBe(true);
      const rows = store.listUnconsumedOutbox();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ executionId: 'execution-1', consumedAt: null });
      expect(store.complete('execution-1', '{}')).toBe(false);
      expect(store.listUnconsumedOutbox()).toHaveLength(1);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});