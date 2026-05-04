import { describe, it, expect } from 'vitest';
import { TaskExecutor } from '../../../packages/core/src/lifecycle/handlers/task-executor.js';
import { RunnerShell } from '../../../packages/core/src/runner-shell/shell.js';
import { EventEmitter } from '../../../packages/core/src/channels/event-emitter.js';
import { mockAdapter } from '../../contract/fixtures/mock-providers.js';

describe('TaskExecutor', () => {
  it('emits run_started + run_completed and updates state', async () => {
    const emitter = new EventEmitter();
    const events: any[] = [];
    emitter.on(e => events.push(e));
    const shell = new RunnerShell(mockAdapter({ turns: [{ assistantText: 'done', toolCalls: [] }], usage: { inputTokens: 1, outputTokens: 2, cachedReadTokens: 0, cachedNonReadTokens: 0 } }));
    const exec = new TaskExecutor(shell, emitter);
    const state: any = { terminal: false, taskIndex: 0, attemptIndex: 0, runInput: { systemPrompt: '', userMessage: '', toolDefinitions: [], maxTurns: 1, cwd: '/tmp' } };
    await exec.handler(state);
    expect(events.map(e => e.type)).toEqual(['run_started', 'run_completed']);
    expect(state.workerStatus).toBe('done');
  });
});
