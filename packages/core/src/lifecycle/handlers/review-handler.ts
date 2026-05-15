import type { LifecycleState } from '../stage-plan-types.js';
import type { StageGate, ReviewPayload, Finding } from '../stage-io.js';
import { specReviewPrompt }    from '../../review/templates/spec-review.js';
import { qualityReviewPrompt } from '../../review/templates/quality-review.js';
import { parseReviewReport }   from '../../review/parse-review-report.js';
import { runReviewerTurn }     from '../../review/run-reviewer.js';

export async function reviewHandler(state: LifecycleState): Promise<StageGate<ReviewPayload>> {
  const t0 = Date.now();
  const policy = state.reviewPolicy; // 'full' | 'quality_only' | 'diff_only' | 'none'
  const runSpec    = policy === 'full' || policy === 'quality_only';
  const runQuality = policy === 'full' || policy === 'diff_only';

  const impl = (state.gates?.['implement']?.payload ?? {}) as { summary?: string; filesChanged?: string[] };
  const briefObj = (state.task ?? {}) as { brief?: string };
  const briefStr = briefObj.brief ?? '';
  const context = {
    brief: briefStr,
    workerSummary: impl.summary,
    filesChanged: impl.filesChanged ?? [],
  };

  const subResults: Array<{ name: 'spec' | 'quality'; result: any; cost: number | null; ms: number }> = [];

  if (runSpec) {
    const r = await runReviewerWithRetries(state, specReviewPrompt(context), 'spec');
    subResults.push({ name: 'spec', result: r.parsed, cost: r.costUSD, ms: r.ms });
  }
  if (runQuality) {
    const r = await runReviewerWithRetries(state, qualityReviewPrompt(context), 'quality');
    subResults.push({ name: 'quality', result: r.parsed, cost: r.costUSD, ms: r.ms });
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
): Promise<{ parsed: ReturnType<typeof parseReviewReport>; costUSD: number | null; ms: number }> {
  const turn = await runReviewerTurn({ prompt, ctx: state.executionContext as any, reviewer: name });
  if (turn.kind === 'transport_error') {
    // Final failure surfaces as a parse-failure shape so the aggregator treats
    // this reviewer as errored — same downstream effect as an unparseable response.
    return {
      parsed: { verdict: undefined, findings: [], parseError: turn.message } as any,
      costUSD: null,
      ms: turn.ms,
    };
  }
  const parsed = parseReviewReport(turn.text);
  return { parsed, costUSD: turn.costUSD, ms: turn.ms };
}