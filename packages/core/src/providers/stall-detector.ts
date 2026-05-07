// Stall and tool-call activity heuristics, separate from completion-text
// heuristics in supervision.ts. Used by the supervision loop and the
// escalation orchestrator to decide when a worker is stuck (looping,
// no-new-files, no-completed-work).

/** camelCase tool names (matching tracker.trackToolCall format in definitions.ts)
 *  that indicate meaningful completed work — file mutations or shell execution. */
export const COMPLETED_WORK_TOOLS = new Set(['writeFile', 'editFile', 'runShell']);

/** Maximum consecutive degenerate outputs (empty/thinking-only) before giving up.
 *  Only counted when the worker has NO `writeFile`/`editFile`/`runShell` yet
 *  (reads don't count as "completed work"). Workers that read many files before
 *  they feel ready to write legitimately spend several turns "thinking" first —
 *  the cap should be generous enough for that pattern. 6 covers heavy-read
 *  tasks (plan implementation, wide refactors) while still bounding truly-stuck
 *  runs. Complex-tier runners that hit this cap fast are still bounded by
 *  maxCostUSD and timeoutMs. */
export const MAX_DEGENERATE_RETRIES = 6;

/** Number of consecutive turns with no new file interactions before injecting a stall warning. */
export const STALL_DETECTION_TURNS = 5;

export function extractToolName(toolCallEntry: string): string {
  const parenIndex = toolCallEntry.indexOf('(');
  return parenIndex === -1 ? toolCallEntry : toolCallEntry.slice(0, parenIndex);
}

export function hasCompletedWork(toolCalls: string[]): boolean {
  return toolCalls.some(tc => COMPLETED_WORK_TOOLS.has(extractToolName(tc)));
}

/** Detect if the worker is making the same tool calls repeatedly (stuck in a loop). */
export function detectToolCallLoop(toolCalls: string[], windowSize: number = 6): boolean {
  if (windowSize % 2 !== 0) throw new Error('windowSize must be even');
  if (toolCalls.length < windowSize) return false;
  const recent = toolCalls.slice(-windowSize);
  const half = windowSize / 2;
  const firstHalf = recent.slice(0, half).join('|');
  const secondHalf = recent.slice(half).join('|');
  return firstHalf === secondHalf;
}

/** Detect if the worker has stalled — no new file interactions over consecutive turns.
 *  Caller maintains a counter of consecutive stall turns and resets it when new activity happens. */
export function hasNewFileActivity(
  filesReadBefore: number,
  filesWrittenBefore: number,
  filesReadNow: number,
  filesWrittenNow: number,
): boolean {
  return filesReadNow > filesReadBefore || filesWrittenNow > filesWrittenBefore;
}
