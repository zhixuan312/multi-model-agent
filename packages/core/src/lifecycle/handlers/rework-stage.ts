// v4.4.x — Rework stage.
//
// Fires only when reviewVerdict === 'changes_required'. Runs on the
// same standard session that did Implementing (full conversation
// continuity). Worker is asked to address the reviewer's concerns.
// Rework's WorkerOutput merges onto Implementing's per the spec's
// "Rework → Implementing field merge rules": summary/workerStatus/unresolved/commitMessage take Rework's
// values; filesChanged is the union of both phases.

import type { LifecycleState } from '../stage-plan-types.js';
import { reviewPayload } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, RuntimeRunResult, AgentType, TaskSpec } from '../../types.js';
import type { Session } from '../../types/run-result.js';
import type { StageGate, ReworkPayload } from '../stage-io.js';
import { replaceLastRunResultPreservingTrackers, mergeStageStats } from '../merge-stage-stats.js';
import { reworkPrompt } from './rework-prompt.js';
import { buildWarmFollowupMessage } from '../warm-followup.js';
import { assembleRunResult } from '../../providers/assemble-run-result.js';
import { parseWorkerOutput } from '../worker-output-contract.js';
import { HUMAN_LABEL } from '../stage-labels.js';
import { startProgressWatchdog, recordPostHocSignals } from '../../bounded-execution/progress-watchdog.js';
import type { ProgressWatchdogConfig } from '../../bounded-execution/progress-watchdog.js';

function reworkSkip(comment: string, t0: number): StageGate<ReworkPayload | null> {
  return {
    outcome: 'skip',
    comment,
    payload: null,
    telemetry: { stageLabel: 'rework', durationMs: Date.now() - t0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
  };
}
function reworkHalt(comment: string, t0: number): StageGate<ReworkPayload | null> {
  return {
    outcome: 'halt',
    comment,
    payload: null,
    telemetry: { stageLabel: 'rework', durationMs: Date.now() - t0, costUSD: 0, turnsUsed: 0, stopReason: 'transport_error' },
  };
}

export async function reworkHandler(state: LifecycleState): Promise<StageGate<ReworkPayload | null>> {
  const t0 = Date.now();
  if (state.terminal) return reworkSkip('rework skipped: terminal', t0);
  if (state.reworkApplied !== undefined || state.reworkError !== undefined) {
    return reworkSkip('rework already applied', t0);
  }
  if (reviewPayload(state).verdict !== 'changes_required') {
    return reworkSkip('rework skipped: review verdict is not changes_required', t0);
  }

  const ctx = state.executionContext as ExecutionContext | undefined;
  const task = state.task as TaskSpec | undefined;
  const last = state.lastRunResult as RuntimeRunResult | undefined;
  if (!ctx || !task || !last) return reworkSkip('rework skipped: missing context', t0);

  const findings = reviewPayload(state).findings;
  if (findings.length === 0) {
    state.reworkApplied = false;
    return reworkSkip('rework skipped: review produced no findings', t0);
  }

  let cumulativeDiff = '';
  if (state.diffTracker) {
    try { cumulativeDiff = await state.diffTracker.cumulativeDiff(); } catch { /* tolerated */ }
  }

  // Rework matches the implementer's tier — rework's job is to FIX the
  // implementer's work, so it needs the same capability. Read implementer
  // tier from executionContext.assignedTier; fall back to the implementing
  // stage's gate payload, then 'standard' as a defensive last resort.
  // Final fallback: if the matched tier has no provider configured, use
  // whichever tier does (parity with reviewer's fallback behavior).
  const desiredReworkTier: AgentType =
    (ctx as { assignedTier?: AgentType }).assignedTier
    ?? ((state.gates?.['implement']?.payload as { agentTier?: AgentType } | null)?.agentTier)
    ?? 'standard';
  const reworkTier: AgentType = ctx.providers[desiredReworkTier]
    ? desiredReworkTier
    : (ctx.providers['standard'] ? 'standard' : 'complex');
  const provider = ctx.providers[reworkTier] as Provider | undefined;
  if (!provider) {
    state.reworkError = `no provider available for tier ${reworkTier}`;
    return reworkHalt(`no provider available for tier ${reworkTier}`, t0);
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
    buildWarmFollowupMessage(reworkPrompt(promptCtx))
    + '\n\nDo NOT run git history-mutating commands (commit / add / push / reset / rebase / etc.) — the Committing stage will handle persistence at the end.';

  let result: RuntimeRunResult;
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
      emit: (_event) => { /* progress-watchdog signals now flow through envelope.recordStall + log-writer */ },
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
    return reworkHalt(`rework session.send failed: ${state.reworkError}`, t0);
  } finally {
    disposeWd?.();
  }
  if (wdConfig.enabled && turn !== undefined) {
    await recordPostHocSignals(
      state,
      (turn as { turns?: number }).turns ?? 0,
      wdConfig,
      (_event) => { /* progress-watchdog signals now flow through envelope + log-writer */ },
      ctx.taskIndex,
      ctx.batchId,
    );
  }

  if (result.status !== 'ok') {
    state.reworkError = `rework returned status: ${result.status}`;
    return reworkHalt(state.reworkError, t0);
  }

  // Parse the Rework worker's WorkerOutput JSON block.
  const reworked = parseWorkerOutput(result.output ?? '');

  state.reworkApplied = true;
  state.reworkOutput = result.output;
  replaceLastRunResultPreservingTrackers(state, result);

  // Apply merge rules: Rework owns summary/workerStatus/unresolved/commitMessage;
  // filesChanged is the union of Implementing's + Rework's.
  const merged = state.lastRunResult as Record<string, unknown> | undefined;
  if (merged) {
    const priorFilesChanged = ((last as { filesChanged?: string[] }).filesChanged) ?? [];
    merged.summary = reworked.summary;
    merged.workerStatus = reworked.workerSelfAssessment;
    merged.filesChanged = Array.from(new Set([...priorFilesChanged, ...reworked.filesChanged]));
    // v5: unresolved, commitMessage removed from worker output schema
    merged.unresolved = (reworked as any).unresolved ?? [];
    if ((reworked as any).commitMessage) merged.commitMessage = (reworked as any).commitMessage;
    // Persist parsedCleanly from rework so enrichRuntimeResult can access it
    merged.parsedCleanly = reworked.parsedCleanly;
  }

  mergeStageStats(state, 'rework', {
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    cachedReadTokens: result.usage?.cachedReadTokens ?? 0,
    cachedNonReadTokens: result.usage?.cachedNonReadTokens ?? 0,
    turnCount: result.turns ?? 1,
    // `result` comes from assembleRunResult which writes the turn cost to
    // top-level `actualCostUSD` (not a `costUSD` field). Reading the wrong
    // field name was the historical cause of rework stages recording
    // cost=null/0 in telemetry; canonical lookup is `actualCostUSD` with
    // legacy `costUSD` as a safety fallback.
    costUSD: (result as { actualCostUSD?: number | null }).actualCostUSD ?? (result as { costUSD?: number | null }).costUSD ?? null,
    durationMs: (result as { durationMs?: number }).durationMs ?? null,
    filesWrittenCount: Array.isArray(result.filesWritten) ? result.filesWritten.length : 0,
  }, {
    tier: reworkTier,
    model: (ctx.providers[reworkTier]?.config as { model?: string } | undefined)?.model ?? null,
  });

  const payload: ReworkPayload = {
    workerSelfAssessment: reworked.workerSelfAssessment === 'done' ? 'done' : 'failed',
    summary: reworked.summary ?? '',
    filesChanged: (state.lastRunResult as { filesChanged?: string[] } | undefined)?.filesChanged ?? [],
    unaddressedFindingIds: [],
    parsedCleanly: reworked.parsedCleanly,
  };
  return {
    outcome: 'advance',
    payload,
    telemetry: {
      stageLabel: 'rework',
      durationMs: Date.now() - t0,
      costUSD: (result as { actualCostUSD?: number | null }).actualCostUSD ?? null,
      turnsUsed: result.turns ?? 1,
      stopReason: 'normal',
    },
  };
}
