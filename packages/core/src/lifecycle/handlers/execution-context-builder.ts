import type { LifecycleState } from '../stage-plan-types.js';
import { makeToolDefinitions } from '../../providers/tool-definitions.js';
import { CallCache } from '../../providers/call-cache.js';
import { SAFETY_MAX_TURNS } from '../../bounded-execution/safety-max-turns.js';

export class ExecutionContextBuilder {
  handler = (state: LifecycleState): void => {
    const cwd = state.cwd as string;
    state.runInput = {
      systemPrompt: state.systemPrompt,
      userMessage: state.userMessage,
      toolDefinitions: makeToolDefinitions({ cwd }),
      maxTurns: (state.maxTurns as number) ?? SAFETY_MAX_TURNS,
      cwd,
    };
    state.callCache = new CallCache();
  };
}
