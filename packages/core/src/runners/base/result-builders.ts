// Shared RunResult builders. Each runner (openai-runner, claude-runner,
// codex-runner) used to carry a near-identical copy of these four
// buildXResult functions. The provider-specific pieces (how usage is
// sourced, how cost is computed, the exact diagnostic wording) are
// passed in; the shared shape lives here.
import type { RunResult } from '../../types.js';
import type { TokenUsage } from '../types.js';
import type { FileTracker } from '../../tools/tracker.js';
import type { TextScratchpad } from '../../tools/scratchpad.js';

export interface SharedResultUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number | null;
  savedCostUSD: number | null;
}

function usageShape(u: SharedResultUsage): TokenUsage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
    costUSD: u.costUSD,
    savedCostUSD: u.savedCostUSD,
  };
}

export function buildOkResult(args: {
  output: string;
  usage: SharedResultUsage;
  turns: number;
  tracker: FileTracker;
  durationMs: number;
}): RunResult {
  const { output, usage, turns, tracker, durationMs } = args;
  return {
    output,
    status: 'ok',
    usage: usageShape(usage),
    turns,
    filesRead: tracker.getReads(),
    directoriesListed: tracker.getDirectoriesListed(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
    outputIsDiagnostic: false,
    escalationLog: [],
    durationMs,
  };
}

export function buildIncompleteResult(args: {
  usage: SharedResultUsage;
  turns: number;
  tracker: FileTracker;
  scratchpad: TextScratchpad;
  /** Builds the diagnostic string when the scratchpad is empty. Each runner
   *  has slightly different diagnostic wording; this callback keeps that
   *  provider-specific text local while sharing the envelope shape. */
  buildDiagnostic: (ctx: { turns: number; inputTokens: number; outputTokens: number; filesRead: string[]; filesWritten: string[] }) => string;
  durationMs: number;
  reason?: string;
  /** When true, errorCode='degenerate_exhausted' is stamped. */
  stampExhausted?: boolean;
}): RunResult {
  const { usage, turns, tracker, scratchpad, buildDiagnostic, durationMs, reason, stampExhausted } = args;
  const filesRead = tracker.getReads();
  const filesWritten = tracker.getWrites();
  const hasSalvage = !scratchpad.isEmpty();
  const output = hasSalvage
    ? scratchpad.latest()
    : buildDiagnostic({
        turns,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        filesRead,
        filesWritten,
      });
  return {
    output,
    status: 'incomplete',
    ...(stampExhausted && { errorCode: 'degenerate_exhausted' as const }),
    usage: usageShape(usage),
    turns,
    filesRead,
    directoriesListed: tracker.getDirectoriesListed(),
    filesWritten,
    toolCalls: tracker.getToolCalls(),
    outputIsDiagnostic: !hasSalvage,
    escalationLog: [],
    ...(reason !== undefined && { error: reason }),
    durationMs,
  };
}

export function buildForceSalvageResult(args: {
  providerLabel: string;
  usage: SharedResultUsage;
  turns: number;
  tracker: FileTracker;
  scratchpad: TextScratchpad;
  softLimit: number;
  durationMs: number;
}): RunResult {
  const { providerLabel, usage, turns, tracker, scratchpad, softLimit, durationMs } = args;
  const hasSalvage = !scratchpad.isEmpty();
  return {
    output: hasSalvage
      ? scratchpad.latest()
      : `[${providerLabel} sub-agent forcibly terminated at ${usage.inputTokens} input tokens (soft limit ${softLimit}). No usable text was buffered.]`,
    status: 'incomplete',
    usage: usageShape(usage),
    turns,
    filesRead: tracker.getReads(),
    directoriesListed: tracker.getDirectoriesListed(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
    outputIsDiagnostic: !hasSalvage,
    escalationLog: [],
    durationMs,
  };
}

export function buildMaxTurnsExitResult(args: {
  usage: SharedResultUsage;
  turns: number;
  tracker: FileTracker;
  scratchpad: TextScratchpad;
  lastOutput: string;
  reason?: string;
  durationMs: number;
}): RunResult {
  const { usage, turns, tracker, scratchpad, lastOutput, reason, durationMs } = args;
  const hasSalvage = !scratchpad.isEmpty();
  const output = hasSalvage
    ? scratchpad.latest()
    : (lastOutput || `Agent exhausted time or cost budget.`);
  const outputIsDiagnostic = !hasSalvage && !lastOutput;
  return {
    output,
    status: 'incomplete',
    errorCode: 'degenerate_exhausted',
    usage: usageShape(usage),
    turns,
    filesRead: tracker.getReads(),
    directoriesListed: tracker.getDirectoriesListed(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
    outputIsDiagnostic,
    escalationLog: [],
    ...(reason !== undefined && { error: reason }),
    durationMs,
  };
}
