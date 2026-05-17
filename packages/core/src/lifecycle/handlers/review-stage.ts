import type { LifecycleState } from '../stage-plan-types.js';
import type { StageGate, ReviewPayload, Finding } from '../stage-io.js';
import { specReviewPrompt }    from '../../review/templates/spec-review.js';
import { qualityReviewPrompt } from '../../review/templates/quality-review.js';
import { parseReviewReport }   from '../../review/parse-review-report.js';
import { runReviewerTurn, invertedReviewerTier } from '../../review/run-reviewer.js';
import { mergeStageStats }     from '../merge-stage-stats.js';
import type { AgentType } from '../../types.js';
import type { ExecutionContext } from '../lifecycle-context.js';

export async function reviewHandler(state: LifecycleState): Promise<StageGate<ReviewPayload>> {
  const t0 = Date.now();
  const policy = state.reviewPolicy; // 'full' | 'quality_only' | 'diff_only' | 'none'
  // v5 review-policy mapping (per spec §14 assumption 2 — adapted to v4 enum):
  //   'full'         → run BOTH spec + quality
  //   'quality_only' → run ONLY quality
  //   'diff_only'    → run ONLY spec (spec reviewer is the closest analog)
  //   'none'         → skip (handled upstream)
  const runSpec    = policy === 'full' || policy === 'diff_only';
  const runQuality = policy === 'full' || policy === 'quality_only';

  const impl = (state.gates?.['implement']?.payload ?? {}) as { summary?: string; filesChanged?: string[] };
  const briefObj = (state.task ?? {}) as { brief?: string };
  const briefStr = briefObj.brief ?? '';
  const context = {
    brief: briefStr,
    workerSummary: (impl?.summary ?? "") as string,
    filesChanged: impl.filesChanged ?? [],
  };

  type SubResult = {
    name: 'spec' | 'quality';
    result: any;
    cost: number | null;
    ms: number;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    cachedNonReadTokens: number;
    turnsUsed: number;
  };
  const subResults: SubResult[] = [];

  // Cross-tier inversion (per design): reviewer runs on the opposite tier of
  // the implementer. Read implementer tier from the executionContext; fall
  // back to inferring from the implementing stage's gate payload, then
  // 'standard' if neither is known (defensive — matches legacy default).
  const implementerTier: AgentType =
    (state.executionContext as { assignedTier?: AgentType } | undefined)?.assignedTier
    ?? ((state.gates?.['implement']?.payload as { agentTier?: AgentType } | null)?.agentTier)
    ?? 'standard';
  const resolvedReviewerTier: AgentType = invertedReviewerTier(implementerTier);

  if (runSpec) {
    const r = await runReviewerWithRetries(state, specReviewPrompt(context), 'spec', implementerTier);
    subResults.push({
      name: 'spec', result: r.parsed, cost: r.costUSD, ms: r.ms,
      model: r.model,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      cachedReadTokens: r.cachedReadTokens, cachedNonReadTokens: r.cachedNonReadTokens,
      turnsUsed: r.turnsUsed,
    });
  }
  if (runQuality) {
    const r = await runReviewerWithRetries(state, qualityReviewPrompt(context), 'quality', implementerTier);
    subResults.push({
      name: 'quality', result: r.parsed, cost: r.costUSD, ms: r.ms,
      model: r.model,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      cachedReadTokens: r.cachedReadTokens, cachedNonReadTokens: r.cachedNonReadTokens,
      turnsUsed: r.turnsUsed,
    });
  }

  const succeeded = subResults.filter(s => s.result.verdict).map(s => s.name);
  const errored = subResults.filter(s => !s.result.verdict).map(s => ({
    reviewer: s.name, error: s.result.parseError ?? 'unknown',
  }));

  const findings: Finding[] = [];
  let nextId = 1;
  for (const s of subResults) {
    for (const f of s.result.findings ?? []) {
      findings.push({ ...f, id: `F${nextId++}`, source: 'reviewer' });
    }
  }

  // Combined verdict: approved iff EVERY configured reviewer returned approved.
  let verdict: 'approved' | 'changes_required';
  if (succeeded.length === 0) {
    verdict = 'changes_required';
    findings.push({
      id: `F${nextId++}`, severity: 'high', category: 'reviewer-availability',
      claim: 'All configured reviewers failed to parse their output; defaulting to changes_required.',
      evidence: errored.map(e => `${e.reviewer}: ${e.error}`).join(' | '),
      source: 'reviewer',
    });
  } else if (subResults.some(s => s.result.verdict === 'changes_required')) {
    verdict = 'changes_required';
  } else if (errored.length > 0) {
    // Mixed: some approved, some errored.
    verdict = 'changes_required';
    for (const e of errored) {
      findings.push({
        id: `F${nextId++}`, severity: 'high', category: 'reviewer-availability',
        claim: `Reviewer ${e.reviewer} failed to parse; treating as changes_required.`,
        evidence: e.error.length >= 20 ? e.error : `parse error: ${e.error}`,
        source: 'reviewer',
      });
    }
  } else {
    verdict = 'approved';
  }

  const totalCost = subResults.reduce((s, x) => s + (x.cost ?? 0), 0);
  const totalMs = subResults.reduce((s, x) => s + x.ms, 0);
  const totalInput = subResults.reduce((s, x) => s + x.inputTokens, 0);
  const totalOutput = subResults.reduce((s, x) => s + x.outputTokens, 0);
  const totalCachedRead = subResults.reduce((s, x) => s + x.cachedReadTokens, 0);
  const totalCachedNonRead = subResults.reduce((s, x) => s + x.cachedNonReadTokens, 0);
  const totalTurns = subResults.reduce((s, x) => s + x.turnsUsed, 0);
  // Both reviewers run on the standard tier through the same Session — same
  // canonical model in practice. Pick the first non-null.
  const reviewerModel = subResults.find(s => s.model !== null)?.model ?? null;

  // Write reviewer stage stats so event-builder.buildReviewStage(rr.stageStats?.review)
  // produces a real stage entry instead of returning null. Without this, the
  // review stage was silently invisible in telemetry for reviewPolicy=full runs.
  if (subResults.length > 0) {
    mergeStageStats(state, 'review', {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedReadTokens: totalCachedRead,
      cachedNonReadTokens: totalCachedNonRead,
      turnCount: totalTurns,
      toolCallCount: 0,
      costUSD: totalCost,
      durationMs: Math.max(totalMs, Date.now() - t0),
      filesReadCount: 0,
      filesWrittenCount: 0,
    }, { tier: resolvedReviewerTier, model: reviewerModel });
  }

  return {
    outcome: 'advance',
    payload: { verdict, findings, reviewersSucceeded: succeeded, reviewersErrored: errored },
    telemetry: {
      stageLabel: 'review',
      durationMs: Math.max(totalMs, Date.now() - t0),
      costUSD: totalCost > 0 ? totalCost : null,
      turnsUsed: subResults.length,
      stopReason: 'normal',
    },
  };
}

async function runReviewerWithRetries(
  state: LifecycleState,
  prompt: string,
  name: 'spec' | 'quality',
  implementerTier: AgentType,
): Promise<{
  parsed: ReturnType<typeof parseReviewReport>;
  costUSD: number | null;
  ms: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedNonReadTokens: number;
  turnsUsed: number;
}> {
  const turn = await runReviewerTurn({
    prompt,
    ctx: state.executionContext as any,
    reviewer: name,
    implementerTier,
  });
  if (turn.kind === 'transport_error') {
    // Final failure surfaces as a parse-failure shape so the aggregator treats
    // this reviewer as errored — same downstream effect as an unparseable response.
    return {
      parsed: { verdict: undefined, findings: [], parseError: turn.message } as any,
      costUSD: null,
      ms: turn.ms,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedNonReadTokens: 0,
      turnsUsed: 0,
    };
  }
  const parsed = parseReviewReport(turn.text);
  return {
    parsed,
    costUSD: turn.costUSD,
    ms: turn.ms,
    model: turn.model,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cachedReadTokens: turn.cachedReadTokens,
    cachedNonReadTokens: turn.cachedNonReadTokens,
    turnsUsed: turn.turnsUsed,
  };
}