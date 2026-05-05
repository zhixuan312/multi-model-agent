import type { LifecycleState } from '../stage-plan-types.js';
import type { RunnerShell } from '../../providers/runner-shell.js';
import type { EventEmitter } from '../../events/event-emitter.js';

export class TaskExecutor {
  constructor(private shell: RunnerShell, private emitter: EventEmitter) {}

  handler = async (state: LifecycleState): Promise<void> => {
    this.emitter.emit({ type: 'run_started', taskIndex: state.taskIndex, attempt: state.attemptIndex });
    const result = await this.shell.run(state.runInput as any);
    state.workerStatus = result.workerStatus;
    state.lastRunResult = result;
    this.emitter.emit({ type: 'run_completed', taskIndex: state.taskIndex, attempt: state.attemptIndex, usage: result.usage });
  };
}
