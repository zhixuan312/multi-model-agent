import type {
  Provider,
  RunResult,
  TaskSpec,
  AgentType,
} from '../types.js';
import type { InternalRunnerEvent } from '../runners/types.js';
import { delegateWithEscalation } from '../delegate-with-escalation.js';

export function errorResult(error: string): RunResult {
  return {
    output: `Sub-agent error: ${error}`,
    status: 'error',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
    turns: 0,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: true,
    escalationLog: [],
    error,
  };
}

export type ResolvedTask =
  | { task: TaskSpec; resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } }
  | { task: TaskSpec; error: string; errorCode: string };

export function withDoneCondition(task: TaskSpec): TaskSpec {
  if (!task.done) return task;
  return { ...task, prompt: `${task.prompt}\n\n## Success Criteria\n${task.done}` };
}

export async function executeTask(
  resolved: Exclude<ResolvedTask, { error: string }>,
  onProgress?: (event: InternalRunnerEvent) => void,
): Promise<RunResult> {
  try {
    return await delegateWithEscalation(
      withDoneCondition(resolved.task),
      [resolved.resolved.provider],
      { explicitlyPinned: true, onProgress },
    );
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
