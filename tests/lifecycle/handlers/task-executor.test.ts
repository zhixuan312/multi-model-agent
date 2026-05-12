import { describe, it, expect } from 'vitest';
import { TaskExecutor } from '../../../packages/core/src/lifecycle/handlers/task-executor.js';
import { EventEmitter } from '../../../packages/core/src/events/event-emitter.js';
import type { Session, TurnResult } from '../../../packages/core/src/types/run-result.js';

function makeSession(turn: TurnResult): Session {
  return {
    async send(_instruction: string): Promise<TurnResult> { return turn; },
    async close(): Promise<void> { /* no-op */ },
  };
}

describe('TaskExecutor', () => {
  it('emits run_started + run_completed and updates state from session.send()', async () => {
    const emitter = new EventEmitter();
    const events: any[] = [];
    emitter.on(e => events.push(e));

    const session = makeSession({
      output: 'done',
      usage: { inputTokens: 1, outputTokens: 2, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      filesRead: [],
      filesWritten: [],
      toolCallsByName: {},
      turns: 1,
      durationMs: 10,
      costUSD: 0,
      terminationReason: 'ok',
    });

    const exec = new TaskExecutor(emitter);
    const state: any = {
      terminal: false,
      taskIndex: 0,
      attemptIndex: 0,
      systemPrompt: 'sys',
      userMessage: 'do the thing',
      executionContext: {
        assignedTier: 'standard',
        getSession: () => session,
      },
    };

    await exec.handler(state);
    expect(events.map(e => e.type)).toEqual(['run_started', 'run_completed']);
    expect(state.lastRunResult.output).toBe('done');
    expect(state.workerStatus).toBeTruthy();
  });

  it('throws when state.executionContext is missing', async () => {
    const emitter = new EventEmitter();
    const exec = new TaskExecutor(emitter);
    const state: any = { taskIndex: 0, attemptIndex: 0 };
    await expect(exec.handler(state)).rejects.toThrow(/executionContext/);
  });
});
