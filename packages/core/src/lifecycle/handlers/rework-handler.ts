// v4.4.x — Rework stage.
//
// Fires only when reviewVerdict === 'changes_required'. Runs on the
// same standard session that did Implementing (full conversation
// continuity). Worker is asked to address the reviewer's concerns AND
// re-run any verifyCommand. Rework's WorkerOutput merges onto
// Implementing's per the spec's "Rework → Implementing field merge
// rules": summary/workerStatus/unresolved/commitMessage take Rework's
// values; filesChanged is the union of both phases; validationsRun is
// REPLACED by Rework's value (empty list signals validation_stale to
// Committing).

import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, RunResult, AgentType, TaskSpec } from '../../types.js';
import type { Session } from '../../types/run-result.js';
import { replaceLastRunResultPreservingTrackers, mergeStageStats } from '../merge-stage-stats.js';
import { reworkTemplate } from '../../review/templates/rework.js';
import { buildWarmFollowupMessage } from '../warm-followup.js';
import { assembleRunResult } from '../../providers/assemble-run-result.js';
import { parseWorkerOutput } from '../worker-output-contract.js';
import { HUMAN_LABEL } from '../stage-labels.js';
import { startProgressWatchdog, recordPostHocSignals } from '../../bounded-execution/progress-watchdog.js';
import type { ProgressWatchdogConfig } from '../../bounded-execution/progress-watchdog.js';

export async function reworkHandler(state: LifecycleState): Promise<void> {
  if (state.terminal) return;
  if (state.reworkApplied !== undefined || state.reworkError !== undefined) return;
  if (state.reviewVerdict !== 'changes_required') return;

  const ctx = state.executionContext as ExecutionContext | undefined;
  const task = state.task as TaskSpec | undefined;
  const last = state.lastRunResult as RunResult | undefined;
  if (!ctx || !task || !last) return;

  const findings = state.reviewFindings ?? [];
  if (findings.length === 0) {
    state.reworkApplied = false;
    return;
  }

  let cumulativeDiff = '';
  if (state.diffTracker) {
    try { cumulativeDiff = await state.diffTracker.cumulativeDiff(); } catch { /* tolerated */ }
  }

  const reworkTier: AgentType = 'standard';
  const provider = ctx.providers[reworkTier] as Provider | undefined;
  if (!provider) {
    state.reworkError = `no provider available for tier ${reworkTier}`;
    return;
  }

  const concerns = findings.map((f) => `[${f.source}] ${f.text}`);
  const promptCtx = {
    brief: task.prompt ?? '',
    workerOutput: last.output ?? '',
    diff: cumulativeDiff,
    planContext: (task as { planContext?: string }).planContext,
    priorConcerns: concerns,
  };
  // Rework always resumes the implementer's thread — the systemPrompt,
  // brief, prior output, and cumulative diff are already in conversation
  // history. We send only the new instruction (reviewer deviations +
  // fix action) wrapped in the standard warm-followup preamble.
  const fullPrompt =
    buildWarmFollowupMessage(reworkTemplate.buildUserPrompt(promptCtx))
    + '\n\nAfter your edits, re-run any verifyCommand the brief specifies and include the fresh validationsRun results in your structured output. Do NOT run git history-mutating commands (commit / add / push / reset / rebase / etc.) — the Committing stage will handle persistence at the end.';

  let result: RunResult;
  // Wire progress watchdog around the rework session.send.
  const wdConfig: ProgressWatchdogConfig = {
    enabled: (ctx.config?.defaults as { progressWatchdogEnabled?: boolean })?.progressWatchdogEnabled ?? true,
    thrashTurns: (ctx.config?.defaults as { thrashTurns?: number })?.thrashTurns ?? 25,
    thrashWallClockMs: (ctx.config?.defaults as { thrashWallClockMs?: number })?.thrashWallClockMs ?? 1_200_000,
    thrashSoftWallClockMs: 600_000,
  };
  const wdState2 = { fired: false };
  const wdController = ctx.stall.controller;
  let disposeWd: (() => void) | undefined;
  if (wdConfig.enabled) {
    disposeWd = startProgressWatchdog({
      state,
      controller: wdController,
      emit: (event) => { ctx.bus?.emit(event as Parameters<typeof ctx.bus.emit>[0]); },
      config: wdConfig,
      taskIndex: ctx.taskIndex,
      batchId: ctx.batchId,
      state2: wdState2,
    });
  }
  let turn: Awaited<ReturnType<Session['send']>> | undefined;
  try {
    const session = ctx.getSession(reworkTier);
    turn = await session.send(fullPrompt, { stageLabel: HUMAN_LABEL.rework });
    result = assembleRunResult(turn);
  } catch (err) {
    state.reworkError = err instanceof Error ? err.message : String(err);
    disposeWd?.();
    return;
  } finally {
    disposeWd?.();
  }
  if (wdConfig.enabled && turn !== undefined) {
    await recordPostHocSignals(
      state,
      (turn as { turns?: number }).turns ?? 0,
      wdConfig,
      (event) => { ctx.bus?.emit(event as Parameters<typeof ctx.bus.emit>[0]); },
      ctx.taskIndex,
      ctx.batchId,
    );
  }

  if (result.status !== 'ok') {
    state.reworkError = `rework returned status: ${result.status}`;
    return;
  }

  // Parse the Rework worker's WorkerOutput JSON block.
  const reworked = parseWorkerOutput(result.output ?? '');

  state.reworkApplied = true;
  state.reworkOutput = result.output;
  replaceLastRunResultPreservingTrackers(state, result);

  // Apply merge rules: Rework owns summary/workerStatus/unresolved/commitMessage;
  // filesChanged is the union of Implementing's + Rework's; validationsRun is
  // REPLACED by Rework's value (so an empty list signals validation_stale).
  const merged = state.lastRunResult as Record<string, unknown> | undefined;
  if (merged) {
    const priorFilesChanged = ((last as { filesChanged?: string[] }).filesChanged) ?? [];
    merged.summary = reworked.summary;
    merged.workerStatus = reworked.workerSelfAssessment;
    merged.filesChanged = Array.from(new Set([...priorFilesChanged, ...reworked.filesChanged]));
    merged.validationsRun = reworked.validationsRun;
    merged.unresolved = reworked.unresolved;
    if (reworked.commitMessage) merged.commitMessage = reworked.commitMessage;
  }

  mergeStageStats(state, 'rework', {
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    cachedReadTokens: result.usage?.cachedReadTokens ?? 0,
    cachedNonReadTokens: result.usage?.cachedNonReadTokens ?? 0,
    turnCount: result.turns ?? 1,
    toolCallCount: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
    // `result` comes from assembleRunResult which writes the turn cost to
    // top-level `actualCostUSD` (not a `costUSD` field). Reading the wrong
    // field name was the historical cause of rework stages recording
    // cost=null/0 in telemetry; canonical lookup is `actualCostUSD` with
    // legacy `costUSD` as a safety fallback.
    costUSD: (result as { actualCostUSD?: number | null }).actualCostUSD ?? (result as { costUSD?: number | null }).costUSD ?? null,
    durationMs: (result as { durationMs?: number }).durationMs ?? null,
    filesReadCount: Array.isArray(result.filesRead) ? result.filesRead.length : 0,
    filesWrittenCount: Array.isArray(result.filesWritten) ? result.filesWritten.length : 0,
  }, {
    tier: reworkTier,
    model: (ctx.providers[reworkTier]?.config as { model?: string } | undefined)?.model ?? null,
  });
}
