import { describe, it, expect, vi } from 'vitest';

// Hoisted mutable state — vi.mock factories are hoisted above imports, so the
// state they close over must be created with vi.hoisted (a hoisted factory
// can't reference ordinary module-scope locals).
const h = vi.hoisted(() => ({ lockCalls: [] as string[], executeCalls: { n: 0 } }));

vi.mock('../../packages/server/src/http/journal-lock.js', () => ({
  withProjectJournalLock: async (cwd: string, fn: () => Promise<unknown>) => { h.lockCalls.push(cwd); return fn(); },
  __journalLockMapSize: () => 0,
}));
vi.mock('@zhixuan92/multi-model-agent-core/lifecycle/task-executor', () => ({
  executeTask: async () => { h.executeCalls.n++; return { completed: true }; },
}));

const { journalRecordExecutor } =
  await import('../../packages/server/src/http/handlers/tools/journal-record.js');

describe('journalRecordExecutor (AC-5 wiring)', () => {
  it('wraps executeTask in withProjectJournalLock for the given cwd', async () => {
    h.lockCalls.length = 0; h.executeCalls.n = 0;
    const run = journalRecordExecutor({ learnings: ['x'.repeat(20)] }, '/proj');
    await run({} as never);
    expect(h.lockCalls).toEqual(['/proj']);
    expect(h.executeCalls.n).toBe(1);
  });
});
