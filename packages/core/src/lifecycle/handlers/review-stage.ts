import type { LifecycleState } from '../stage-plan-types.js';
import type { StageGate, ReviewPayload, Finding } from '../stage-io.js';
import { specReviewPrompt }    from './spec-review-prompt.js';
import { qualityReviewPrompt } from './quality-review-prompt.js';
import { journalReviewPrompt } from './journal-review-prompt.js';
import { parseReviewReport }   from './parse-review-report.js';
import { invertedReviewerTier } from './tier-policy.js';
import { HUMAN_LABEL } from '../stage-labels.js';
import { mergeStageStats }     from '../merge-stage-stats.js';
import { SLICE_CAP_BYTES } from '../../tools/execute-plan/plan-extractor.js';
import type { AgentType } from '../../types.js';

function parseOutcomeFromText(text: string): 'clean' | 'found' | null {
  const outcomeMatch = text.match(/^##\s*outcome\s*$/im);
  if (!outcomeMatch) return null;
  const after = text.slice(outcomeMatch.index! + outcomeMatch[0].length);
  const firstLine = after.split('\n').map(s => s.trim()).find(s => s.length > 0) ?? '';
  if (/found/i.test(firstLine)) return 'found';
  if (/clean/i.test(firstLine)) return 'clean';
  return null;
}

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

  let cumulativeDiff = '';
  if (state.diffTracker) {
    try { cumulativeDiff = await state.diffTracker.cumulativeDiff(); } catch { /* tolerated */ }
  }

  // Truncate diff to SLICE_CAP_BYTES by UTF-8 byte length, reserving space for the truncation marker
  const truncationMarker = '[diff truncated]';
  const diffBytes = Buffer.byteLength(cumulativeDiff, 'utf8');
  if (diffBytes > SLICE_CAP_BYTES) {
    const markerBytes = Buffer.byteLength(truncationMarker, 'utf8');
    const availableBytes = SLICE_CAP_BYTES - markerBytes;

    // Truncate by finding the right position in UTF-8
    let truncated = '';
    let byteCount = 0;
    for (const char of cumulativeDiff) {
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (byteCount + charBytes > availableBytes) break;
      truncated += char;
      byteCount += charBytes;
    }
    cumulativeDiff = truncated + truncationMarker;
  }

  const context = {
    brief: briefStr,
    workerSummary: (impl?.summary ?? "") as string,
    filesChanged: impl.filesChanged ?? [],
    diff: cumulativeDiff,
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
    turn: any;
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

  // journal-record produces markdown ADR nodes, not code — a single
  // node-validation review (frontmatter/edges/schema/confinement/dedup)
  // replaces the code-oriented spec+quality pair, which mis-fits markdown.
  if (state.route === 'journal-record') {
    const r = await runReviewerWithRetries(state, journalReviewPrompt(context), implementerTier);
    subResults.push({
      name: 'quality', result: r.parsed, cost: r.costUSD, ms: r.ms,
      model: r.model,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      cachedReadTokens: r.cachedReadTokens, cachedNonReadTokens: r.cachedNonReadTokens,
      turnsUsed: r.turnsUsed,
      turn: r.turn,
    });
  } else {
  if (runSpec) {
    const r = await runReviewerWithRetries(state, specReviewPrompt(context), implementerTier);
    subResults.push({
      name: 'spec', result: r.parsed, cost: r.costUSD, ms: r.ms,
      model: r.model,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      cachedReadTokens: r.cachedReadTokens, cachedNonReadTokens: r.cachedNonReadTokens,
      turnsUsed: r.turnsUsed,
      turn: r.turn,
    });
  }
  if (runQuality) {
    const r = await runReviewerWithRetries(state, qualityReviewPrompt(context), implementerTier);
    subResults.push({
      name: 'quality', result: r.parsed, cost: r.costUSD, ms: r.ms,
      model: r.model,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      cachedReadTokens: r.cachedReadTokens, cachedNonReadTokens: r.cachedNonReadTokens,
      turnsUsed: r.turnsUsed,
      turn: r.turn,
    });
  }
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

  // Aggregate outcomes from sub-reviewers. If any reviewer found issues, overall outcome = 'found'.
  const subOutcomes: ('clean' | 'found')[] = [];
  for (const s of subResults) {
    const outcome = s.turn && s.turn.text ? parseOutcomeFromText(s.turn.text) : null;
    if (outcome) {
      subOutcomes.push(outcome);
    }
  }
  const findingsOutcome: 'clean' | 'found' = subOutcomes.some(o => o === 'found') ? 'found' : 'clean';

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
      costUSD: totalCost,
      durationMs: Math.max(totalMs, Date.now() - t0),
      filesWrittenCount: 0,
    }, { tier: resolvedReviewerTier, model: reviewerModel, verdict, findingsOutcome });
    // ↑ Pass the combined verdict so it flows: review-stage → mergeStageStats →
    //   state.lastRunResult.stageStats.review.verdict → lifecycle-driver.completeStage →
    //   envelope.stages[review].verdict → to-wire-record stages[review].verdict.
    // Without this, the wire row always shows verdict='skipped' even when
    // review ran with real cost + findings.
  }

  return {
    outcome: 'advance',
    payload: { verdict, findings, reviewersSucceeded: succeeded, reviewersErrored: errored, findingsOutcome },
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
  turn: any;
}> {
  const desired = invertedReviewerTier(implementerTier);
  const providers = (state.executionContext as { providers?: Partial<Record<AgentType, { config?: { model?: string } }>> }).providers;
  const tierToUse: AgentType = providers && providers[desired] ? desired : implementerTier;
  // Capture the actual reviewer model from the provider config for this tier
  // — TurnResult doesn't carry model, and the session's getSession(tierToUse)
  // is what determines which provider config is in use. Without this lookup,
  // the wire row would attribute reviewer cost+tokens to a null model.
  const reviewerModelFromConfig: string | null =
    providers?.[tierToUse]?.config?.model ?? null;
  const session = (state.executionContext as any).getSession(tierToUse);
  let reviewerResult;
  try {
    const r = await session.send(prompt, { stageLabel: HUMAN_LABEL.review });
    reviewerResult = {
      kind: 'ok' as const,
      text: r.output ?? '',
      costUSD: r.costUSD ?? null,
      turnsUsed: r.turns ?? 1,
      ms: 0, // (the wrapper measured this; if downstream needs it, capture Date.now())
      model: reviewerModelFromConfig,
      inputTokens: r.usage?.inputTokens ?? 0,
      outputTokens: r.usage?.outputTokens ?? 0,
      cachedReadTokens: r.usage?.cachedReadTokens ?? 0,
      cachedNonReadTokens: r.usage?.cachedNonReadTokens ?? 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reviewerResult = { kind: 'transport_error' as const, message: msg, ms: 0 };
  }

  if (reviewerResult.kind === 'transport_error') {
    // Final failure surfaces as a parse-failure shape so the aggregator treats
    // this reviewer as errored — same downstream effect as an unparseable response.
    return {
      parsed: { verdict: undefined, findings: [], parseError: reviewerResult.message } as any,
      costUSD: null,
      ms: reviewerResult.ms,
      model: reviewerModelFromConfig,
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedNonReadTokens: 0,
      turnsUsed: 0,
      turn: reviewerResult,
    };
  }
  const ctx = state.executionContext as { envelope?: { recordValidationWarning?: (w: { rule: string; path: string }) => void } } | undefined;
  const warnSink = (event: string, data: Record<string, unknown>) => {
    try {
      ctx?.envelope?.recordValidationWarning?.({
        rule: event,
        path: `${data['reasonCode'] ?? 'unknown'}:${String(data['droppedFindingHeading'] ?? '').slice(0, 120)}`,
      });
    } catch { /* sealed envelope — harmless */ }
  };
  const parsed = parseReviewReport(reviewerResult.text, undefined, warnSink);
  return {
    parsed,
    costUSD: reviewerResult.costUSD,
    ms: reviewerResult.ms,
    model: reviewerResult.model,
    inputTokens: reviewerResult.inputTokens,
    outputTokens: reviewerResult.outputTokens,
    cachedReadTokens: reviewerResult.cachedReadTokens,
    cachedNonReadTokens: reviewerResult.cachedNonReadTokens,
    turnsUsed: reviewerResult.turnsUsed,
    turn: reviewerResult,
  };
}