// Phase-2 of a write goal-set: one autonomous review-fix send on the
// configured phase-2 tier. The agent reviews each task's commit against the
// plan (matched via `[task N]`), fixes issues, and self-commits the fixes. Git
// is the handoff — this stage feeds the phase-1 commit log into the prompt and
// records the phase-2 output for the deterministic goal report (annotate).
import type { LifecycleState } from '../stage-plan-types.js';
import type { StageGate } from '../stage-io.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { TaskSpec, RuntimeRunResult } from '../../types.js';
import { assembleRunResult } from '../../providers/assemble-run-result.js';
import { mergeStageStats } from '../merge-stage-stats.js';
import { renderGitLogStat } from '../git-exec.js';
import { reviewFixGoalPrompt, MAX_GIT_LOG_BYTES } from '../goal-prompts.js';
import { HUMAN_LABEL } from '../stage-labels.js';

type ReviewFixPayload = { ran: boolean; output: string };

function tel(t0: number, costUSD: number | null, turns: number, stop: string): StageGate<ReviewFixPayload>['telemetry'] {
  return {
    stageLabel: 'review',
    durationMs: Date.now() - t0,
    costUSD,
    turnsUsed: turns,
    stopReason: stop as StageGate<ReviewFixPayload>['telemetry']['stopReason'],
  };
}

export async function reviewFixHandler(state: LifecycleState): Promise<StageGate<ReviewFixPayload>> {
  const t0 = Date.now();
  const task = state.task as TaskSpec | undefined;
  const ctx = state.executionContext as ExecutionContext | undefined;
  const goal = task?.goal;
  if (!goal || !ctx) {
    return { outcome: 'skip', payload: { ran: false, output: '' }, telemetry: tel(t0, null, 0, 'normal') };
  }

  const baseSha = (state.goalBaseSha as string | undefined) ?? state.preTaskHeadSha;
  if (!baseSha) {
    return { outcome: 'skip', comment: 'review-fix skipped: no baseSha', payload: { ran: false, output: '' }, telemetry: tel(t0, null, 0, 'normal') };
  }

  const phase2Tier = goal.phases[1]?.tier ?? 'complex';
  try {
    const { text: gitLog } = await renderGitLogStat(goal.cwd, baseSha, MAX_GIT_LOG_BYTES);
    const prompt = reviewFixGoalPrompt(goal, gitLog);
    const session = ctx.getSession(phase2Tier);
    const turn = await session.send(prompt, {
      stageLabel: HUMAN_LABEL.review,
      signal: ctx.stall.controller.signal,
    });
    const result = assembleRunResult(turn) as RuntimeRunResult;

    (state as { goalPhase2Output?: string }).goalPhase2Output = result.output ?? '';

    const costUSD = (result as { actualCostUSD?: number | null }).actualCostUSD
      ?? result.cost?.costUSD ?? null;
    mergeStageStats(state, 'review', {
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cachedReadTokens: result.usage?.cachedReadTokens ?? 0,
      cachedNonReadTokens: result.usage?.cachedNonReadTokens ?? 0,
      turnCount: result.turns ?? 0,
      costUSD,
      durationMs: result.durationMs ?? null,
      filesWrittenCount: Array.isArray(result.filesWritten) ? result.filesWritten.length : 0,
    }, {
      tier: phase2Tier,
      model: (ctx.providers[phase2Tier]?.config as { model?: string } | undefined)?.model ?? null,
    });

    return {
      outcome: 'advance',
      payload: { ran: true, output: result.output ?? '' },
      telemetry: tel(t0, costUSD, result.turns ?? 0, 'normal'),
    };
  } catch (err) {
    // Phase-2 failure never discards phase-1 commits; annotate marks
    // done_with_concerns / phase2_incomplete from git state.
    const msg = err instanceof Error ? err.message : String(err);
    (state as { goalPhase2Error?: string }).goalPhase2Error = msg;
    return {
      outcome: 'advance',
      comment: `review-fix error: ${msg}`,
      payload: { ran: true, output: '' },
      telemetry: tel(t0, null, 0, 'transport_error'),
    };
  }
}
