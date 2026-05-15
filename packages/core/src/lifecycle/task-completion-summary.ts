import type { RunResult } from '../types.js';
import {
  clampStageCost,
  clampTaskCost,
  clampInputTokens,
  clampOutputTokens,
  clampDurationMsTotal,
} from '../events/clamp.js';

export interface TaskCompletionSummary {
  batchId: string;
  taskIndexZero: number;
  totalTasks: number;
  terminalStatus: string;
  totalDurationMs: number;
  totalCostUSD: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  turns: number;
  filesWrittenCount: number;
  specReviewVerdict: string;
  qualityReviewVerdict: string;
}

// Derive each total INDEPENDENTLY from stage stats, mirroring event-builder
// exactly. Top-level totals must NEVER depend on runResult.usage — that field
// only carries the last implementer attempt and would lose reviewer + earlier
// rework cost (the same Gap 2 bug we already fixed in event-builder).
//
// Clamping is identical to event-builder via shared helpers from
// packages/core/src/telemetry/clamp.ts — guarantees the summary line and
// the V3 event never disagree on cost/token/duration values.
function deriveTerminalStatus(rr: RunResult): string {
  const tr = rr.terminationReason;
  if (!tr || typeof tr !== 'object') return 'incomplete';
  switch (tr.cause) {
    case 'finished': return 'ok';
    case 'incomplete':
    case 'degenerate_exhausted': return 'incomplete';
    case 'timeout': return 'timeout';
    case 'cost_exceeded': return 'cost_exceeded';
    case 'brief_too_vague': return 'brief_too_vague';
    case 'api_error':
    case 'provider_transport_failure':
    case 'api_aborted':
    case 'error': return 'error';
    default: return 'incomplete';
  }
}

export function computeTaskCompletionSummary(args: {
  runResult: RunResult;
  taskIndexZero: number;
  totalTasks: number;
  batchId: string;
}): TaskCompletionSummary {
  const { runResult, taskIndexZero, totalTasks, batchId } = args;
  const stageEntries = Object.values(runResult.stageStats ?? {}).filter(
    (s) => s.entered,
  );

  // Sum across entered stages with per-stage clamping, then apply
  // top-level clamping — exactly mirroring the two-level clamping in
  // event-builder.ts (extractStageData + buildTaskCompletedEvent).
  const sumFinite = (
    key: string,
    clampStage: (n: number) => number,
    clampTotal: (n: number) => number,
  ): number | null => {
    let total = 0;
    let anyFinite = false;
    for (const s of stageEntries) {
      const v = (s as unknown as Record<string, unknown>)[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        total += clampStage(v);
        anyFinite = true;
      }
    }
    return anyFinite ? clampTotal(total) : null;
  };

  const totalDurationMs = clampDurationMsTotal(
    stageEntries.reduce((s, st) => {
      const v = (st as unknown as Record<string, unknown>)['durationMs'];
      return s + (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    }, 0),
  );

  return {
    batchId,
    taskIndexZero,
    totalTasks,
    terminalStatus: deriveTerminalStatus(runResult),
    totalDurationMs,
    totalCostUSD: sumFinite('costUSD', clampStageCost, clampTaskCost),
    totalInputTokens: sumFinite('inputTokens', clampInputTokens, clampInputTokens),
    totalOutputTokens: sumFinite('outputTokens', clampOutputTokens, clampOutputTokens),
    turns: runResult.turns ?? 0,
    filesWrittenCount: runResult.filesWritten?.length ?? 0,
    specReviewVerdict: (runResult.specReviewStatus as string) ?? 'not_applicable',
    qualityReviewVerdict: (runResult.qualityReviewStatus as string) ?? 'not_applicable',
  };
}

export function formatTaskDoneLine(s: TaskCompletionSummary): string {
  const idx = `task=${s.taskIndexZero + 1}/${s.totalTasks} taskIndex=${s.taskIndexZero}`;
  const dur = formatDur(s.totalDurationMs);
  const tokens = formatTokens(s.totalInputTokens, s.totalOutputTokens);
  const cost = s.totalCostUSD === null ? '$unknown' : `$${s.totalCostUSD.toFixed(2)}`;
  return `[mmagent] batch=${s.batchId.slice(0, 8)} ${idx} done: ${s.terminalStatus} in ${dur}, ${tokens}, ${cost}, ${s.turns} turns, ${s.filesWrittenCount} file(s) written, reviews [spec=${s.specReviewVerdict}, quality=${s.qualityReviewVerdict}]`;
}

function formatDur(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${m}m ${sec}s`;
}

function formatTokens(input: number | null, output: number | null): string {
  if (input === null && output === null) return 'tokens=unknown';
  const total = (input ?? 0) + (output ?? 0);
  if (total < 1000) return `${total} tokens`;
  return `${Math.ceil(total / 1000)}k tokens`;
}
