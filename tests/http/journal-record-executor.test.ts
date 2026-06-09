import { describe, it, expect, vi } from 'vitest';

// Goal mode: the journal per-project lock was folded into the goal-set's
// withWriteGoalLock (in task-executor). The executor now just calls executeTask;
// there is no separate journal lock to wire.
const h = vi.hoisted(() => ({ executeCalls: { n: 0 } }));

vi.mock('@zhixuan92/multi-model-agent-core/lifecycle/task-executor', () => ({
  executeTask: async () => { h.executeCalls.n++; return { completed: true }; },
}));

const { journalRecordExecutor } =
  await import('../../packages/server/src/http/handlers/tools/journal-record.js');

describe('journalRecordExecutor', () => {
  it('calls executeTask directly (per-cwd serialization handled by withWriteGoalLock)', async () => {
    h.executeCalls.n = 0;
    const run = journalRecordExecutor({ learnings: ['x'.repeat(20)] }, '/proj');
    await run({} as never);
    expect(h.executeCalls.n).toBe(1);
  });
});
