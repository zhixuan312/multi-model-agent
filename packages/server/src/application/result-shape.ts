import type { TaskType } from '@zhixuan92/multi-model-agent-core';

/** Extract the last ```json fenced block (or first bare JSON object) from raw
 *  LLM output; falls back to the raw string when nothing parses. */
export function tryParseJson(raw: string): unknown {
  const fenced = [...raw.matchAll(/```json\s*([\s\S]*?)```/g)];
  const match = fenced.length ? fenced[fenced.length - 1] : raw.match(/(\{[\s\S]*\})/);
  if (!match) return raw;
  try { return JSON.parse(match[1]); } catch { return raw; }
}

/**
 * Build a terminal FAILED result that is shape-consistent with the success/pipeline
 * envelope (task, output, execution, metrics, raw, error). Every terminal 200 — success
 * or failure — must have these six keys so callers detect failure uniformly via `error`
 * (the contract documented in _shared/response-shape.md). Used for pre-dispatch/async
 * validation failures and runner crashes, which would otherwise store a bare
 * { code, message } that has no `error` field for callers to check.
 */
export function buildErrorEnvelope(
  taskId: string,
  type: TaskType,
  error: { code: string; message: string } & Record<string, unknown>,
  status: 'failed' | 'cancelled' | 'interrupted' = 'failed',
): Record<string, unknown> {
  return {
    task: { taskId, type, status },
    output: { summary: null, filesChanged: [], contextBlockId: null, reviewerNote: null },
    execution: { sessions: { implementer: null, reviewer: null }, worktree: null },
    metrics: {
      totalDurationMs: 0,
      totalCostUsd: 0,
      implementer: null,
      reviewer: null,
      totalUsage: null,
      mainEquivalentCostUsd: null,
      savedVsMainCostUsd: null,
    },
    raw: { implementer: null, reviewer: null },
    error,
  };
}
