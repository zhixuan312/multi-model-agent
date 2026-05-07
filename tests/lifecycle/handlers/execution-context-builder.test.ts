import { describe, it, expect } from 'vitest';
import { ExecutionContextBuilder } from '../../../packages/core/src/lifecycle/handlers/execution-context-builder.js';

describe('ExecutionContextBuilder', () => {
  it('populates state.runInput with cwd-bound tool definitions', () => {
    const builder = new ExecutionContextBuilder();
    const state: any = { terminal: false, cwd: '/tmp', systemPrompt: 'sys', userMessage: 'hi', maxTurns: 5 };
    builder.handler(state);
    expect(state.runInput.cwd).toBe('/tmp');
    expect(state.runInput.toolDefinitions.length).toBeGreaterThan(0);
    expect(state.callCache).toBeDefined();
  });
});
