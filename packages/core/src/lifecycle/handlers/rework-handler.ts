import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, RunResult, AgentType, TaskSpec } from '../../types.js';
import { replaceLastRunResultPreservingTrackers, mergeStageStats } from '../merge-stage-stats.js';
import { reworkTemplate } from '../../review/templates/rework.js';
import { assembleRunResult } from '../../providers/assemble-run-result.js';

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
    try { cumulativeDiff = await state.diffTracker.cumulativeDiff(); }
    catch { cumulativeDiff = ''; }
  }

  // Rework runs on `standard` — same tier as the original implementing
  // stage. The reviewer's findings are already laid out for the worker to
  // act on; using the complex tier for a constrained "apply these specific
  // fixes" task wastes cost and adds latency without changing outcomes.
  const reworkTier: AgentType = 'standard';
  const provider = ctx.providers[reworkTier] as Provider | undefined;
  if (!provider) {
    state.reworkError = `no provider available for tier ${reworkTier}`;
    return;
  }

  const concerns = findings.map(f => `[${f.source}] ${f.text}`);
  const promptCtx = {
    brief: task.prompt ?? '',
    workerOutput: last.output ?? '',
    diff: cumulativeDiff,
    planContext: (task as { planContext?: string }).planContext,
    priorConcerns: concerns,
  };
  const fullPrompt =
    reworkTemplate.systemPrompt + '\n\n' + reworkTemplate.buildUserPrompt(promptCtx);

  let result: RunResult;
  try {
    const session = ctx.getSession(reworkTier);
    const turn = await session.send(fullPrompt, { stageLabel: 'Rework' });
    result = assembleRunResult(turn);
  } catch (err) {
    state.reworkError = err instanceof Error ? err.message : String(err);
    return;
  }

  if (result.status !== 'ok') {
    state.reworkError = `rework returned status: ${result.status}`;
    return;
  }
  state.reworkApplied = true;
  state.reworkOutput = result.output;
  replaceLastRunResultPreservingTrackers(state, result);
  mergeStageStats(state, 'rework', {
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    cachedReadTokens: result.usage?.cachedReadTokens ?? 0,
    cachedNonReadTokens: result.usage?.cachedNonReadTokens ?? 0,
    turnCount: result.turns ?? 1,
    toolCallCount: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
    costUSD: (result as { costUSD?: number | null }).costUSD ?? null,
    durationMs: (result as { durationMs?: number }).durationMs ?? null,
    filesReadCount: Array.isArray(result.filesRead) ? result.filesRead.length : 0,
    filesWrittenCount: Array.isArray(result.filesWritten) ? result.filesWritten.length : 0,
  }, {
    tier: reworkTier,
    model: (ctx.providers[reworkTier]?.config as { model?: string } | undefined)?.model ?? null,
  });
}
