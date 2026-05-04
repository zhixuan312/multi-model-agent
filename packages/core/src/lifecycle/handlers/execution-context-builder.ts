import type { LifecycleState } from '../stage-plan-types.js';
import { makeToolDefinitions } from '../../runner-shell/tool-definitions.js';
import { CallCache } from '../../tools/call-cache.js';

export class ExecutionContextBuilder {
  handler = (state: LifecycleState): void => {
    const cwd = state.cwd as string;
    state.runInput = {
      systemPrompt: state.systemPrompt,
      userMessage: state.userMessage,
      toolDefinitions: makeToolDefinitions({ cwd }),
      maxTurns: (state.maxTurns as number) ?? 50,
      cwd,
    };
    state.callCache = new CallCache();
  };
}
