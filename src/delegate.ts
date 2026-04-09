import type { DelegateTask, RunResult } from './types.js';

export async function delegateAll(tasks: DelegateTask[]): Promise<RunResult[]> {
  if (tasks.length === 0) return [];

  const promises = tasks.map(async (task): Promise<RunResult> => {
    try {
      return await task.provider.run(task.prompt, {
        tools: task.tools,
        maxTurns: task.maxTurns,
        timeoutMs: task.timeoutMs,
        cwd: task.cwd,
        effort: task.effort,
        sandboxPolicy: task.sandboxPolicy,
      });
    } catch (err) {
      return {
        output: `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
        turns: 0,
        files: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  return Promise.all(promises);
}
