import { describe, it, expect } from 'bun:test';
import { journalRecordExecutor } from '../../packages/server/src/http/handlers/tools/journal-record.js';

// Inject the lock + executor via journalRecordExecutor's deps param instead of
// mock.module() — under Bun mock.module is process-global and STICKY (no per-file
// restore), so mocking the core task-executor here leaked a mocked executeTask
// into every later dispatch test (audit/debug/journal/batch).

describe('journalRecordExecutor (AC-5 wiring)', () => {
  it('wraps executeTask in withProjectJournalLock for the given cwd', async () => {
    const lockCalls: string[] = [];
    let executeCalls = 0;
    const deps = {
      withProjectJournalLock: async (cwd: string, fn: () => Promise<unknown>) => {
        lockCalls.push(cwd);
        return fn();
      },
      executeTask: async () => { executeCalls++; return { completed: true }; },
    } as never;

    const run = journalRecordExecutor({ learnings: ['x'.repeat(20)] } as never, '/proj', deps);
    await run({} as never);

    expect(lockCalls).toEqual(['/proj']);
    expect(executeCalls).toBe(1);
  });
});
