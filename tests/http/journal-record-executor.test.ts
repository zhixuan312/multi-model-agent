import { describe, it, expect, mock } from 'bun:test';

const lockCalls: string[] = [];
let executeCalls = 0;

mock.module('../../packages/server/src/http/journal-lock.js', () => ({
  withProjectJournalLock: async (cwd: string, fn: () => Promise<unknown>) => { lockCalls.push(cwd); return fn(); },
  __journalLockMapSize: () => 0,
}));
mock.module('@zhixuan92/multi-model-agent-core/lifecycle/task-executor', () => ({
  executeTask: async () => { executeCalls++; return { completed: true }; },
}));

const { journalRecordExecutor } =
  await import('../../packages/server/src/http/handlers/tools/journal-record.js');

describe('journalRecordExecutor (AC-5 wiring)', () => {
  it('wraps executeTask in withProjectJournalLock for the given cwd', async () => {
    lockCalls.length = 0; executeCalls = 0;
    const run = journalRecordExecutor({ learnings: ['x'.repeat(20)] }, '/proj');
    await run({} as never);
    expect(lockCalls).toEqual(['/proj']);
    expect(executeCalls).toBe(1);
  });
});
