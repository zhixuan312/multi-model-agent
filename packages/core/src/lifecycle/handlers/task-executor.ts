// TaskExecutor — implementing-stage handler. v4.4: dispatches the worker
// turn directly through the ExecutionContext's Session for the assigned
// tier. Sessions are reused across stages of the same task so subsequent
// rework / annotate stages on the same tier reload prior context via
// codex CLI's `exec resume` or claude-agent-sdk's `resume: sessionId`.

import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { EventEmitter } from '../../events/event-emitter.js';
import { assembleRunResult } from '../../providers/assemble-run-result.js';

export class TaskExecutor {
  constructor(private emitter: EventEmitter) {}

  handler = async (state: LifecycleState): Promise<void> => {
    const ctx = state.executionContext as ExecutionContext | undefined;
    if (!ctx) throw new Error('task-executor: state.executionContext not set');

    const systemPrompt = (state.systemPrompt as string | undefined) ?? '';
    const userMessage = (state.userMessage as string | undefined) ?? '';
    const instruction = systemPrompt.length > 0
      ? `${systemPrompt}\n\n${userMessage}`
      : userMessage;

    this.emitter.emit({
      type: 'run_started',
      taskIndex: state.taskIndex,
      attempt: state.attemptIndex,
    });

    const session = ctx.getSession(ctx.assignedTier);
    const turn = await session.send(instruction, { stageLabel: 'implementing' });
    const result = assembleRunResult(turn);

    state.workerStatus = result.workerStatus ?? 'done';
    state.lastRunResult = result;

    this.emitter.emit({
      type: 'run_completed',
      taskIndex: state.taskIndex,
      attempt: state.attemptIndex,
      usage: result.usage,
    });
  };
}
