// Back-compat enrichment of state.lastRunResult after the v5 lifecycle runs.
//
// The wire envelope (ComposePayload, 8 fields) is the v5 boundary, but
// downstream consumers (recorder, headline composer, batch envelope) still
// expect the runtime-mirror RuntimeRunResult with v4 fields:
//   - specReviewStatus / qualityReviewStatus / diffReviewStatus
//   - agents (tier mapping per role)
//   - models (per-role model names)
//   - implementationReport (fallback parse of last.output)
//   - structuredReport (canonical from annotator, else fallback parser)
//   - reviewerNotes / errors / verdict slots
//   - actualCostUSD (sum across entered stages)
//   - status / errorCode / terminationReason (v5 M3/M4 fixes)
//
// composeHandler calls this AFTER assembling its ComposePayload so that
// terminal-handlers/recorder/headline-composer downstream see the enriched
// runtime mirror exactly as the legacy composeResponse did.

import type { LifecycleState } from '../stage-plan-types.js';
import { reviewPayload } from '../stage-plan-types.js';
import type { RuntimeRunResult } from '../../types.js';
import { parseStructuredReport } from '../../reporting/structured-report.js';
import { sumStageCosts } from '../shared-compute.js';


export function enrichRuntimeResult(state: LifecycleState): void {
  if (state.lastRunResult === undefined) return;

  const last = state.lastRunResult as RuntimeRunResult;
  const enriched: RuntimeRunResult = { ...last };

  // ── actualCostUSD: sum across entered stages ────────────────────────────────
  if (enriched.actualCostUSD === undefined) {
    const stageStats = (last.stageStats ?? undefined) as Record<string, { entered?: boolean; costUSD?: number | null } | undefined> | undefined;
    enriched.actualCostUSD = sumStageCosts(stageStats) ?? 0;
  }

  const e = enriched as unknown as Record<string, unknown>;

  // ── Review-status fields ────────────────────────────────────────────────────
  if (state.specReviewError !== undefined) e.specReviewStatus = 'error';
  else if (state.specReviewVerdict !== undefined) e.specReviewStatus = state.specReviewVerdict;
  else e.specReviewStatus = 'not_applicable';

  if (state.qualityReviewError !== undefined) e.qualityReviewStatus = 'error';
  else if (state.qualityReviewVerdict !== undefined) e.qualityReviewStatus = state.qualityReviewVerdict;
  else e.qualityReviewStatus = 'not_applicable';

  if (state.diffReviewVerdict !== undefined) e.diffReviewStatus = state.diffReviewVerdict;
  else if (state.reviewPolicy === 'full' || state.reviewPolicy === 'diff_only') e.diffReviewStatus = 'skipped';
  else e.diffReviewStatus = 'not_applicable';

  // ── verification, commits, commitError ──────────────────────────────────────
  if (state.verifyResult !== undefined && e.verification === undefined) {
    e.verification = state.verifyResult;
  }
  if (Array.isArray(state.commits) && e.commits === undefined) {
    e.commits = state.commits;
  } else if (e.commits === undefined) {
    e.commits = [];
  }
  if (typeof state.commitError === 'string' && e.commitError === undefined) {
    e.commitError = state.commitError;
  }

  // ── agents map (tier per role) ──────────────────────────────────────────────
  const ctx = state.executionContext;
  if (ctx && e.agents === undefined) {
    const specReviewerTier =
      e.specReviewStatus === 'approved' || e.specReviewStatus === 'changes_required'
        ? (ctx.assignedTier === 'standard' ? 'complex' : 'standard')
        : (e.specReviewStatus === 'not_applicable' ? 'not_applicable' : 'skipped');
    const qualityReviewerTier =
      e.qualityReviewStatus === 'approved' || e.qualityReviewStatus === 'changes_required'
        ? (ctx.assignedTier === 'standard' ? 'complex' : 'standard')
        : (e.qualityReviewStatus === 'not_applicable' ? 'not_applicable' : 'skipped');
    e.agents = {
      implementer: ctx.assignedTier,
      implementerToolMode: ctx.implementerToolMode ?? 'full',
      specReviewer: specReviewerTier,
      qualityReviewer: qualityReviewerTier,
    };
  }


  // ── reviewReason text fields ────────────────────────────────────────────────
  if (e.specReviewReason === undefined) {
    e.specReviewReason = e.specReviewStatus === 'not_applicable' ? 'task produced no file artifacts to review' : '';
  }
  if (e.qualityReviewReason === undefined) {
    e.qualityReviewReason = e.qualityReviewStatus === 'not_applicable' ? 'task produced no file artifacts to review' : '';
  }

  // ── implementationReport + structuredReport (annotator wins; else fallback) ─
  const fallbackReport = (last.output
    ? parseStructuredReport(last.output)
    : { summary: '', filesChanged: [], deviationsFromBrief: [], unresolved: [], extraSections: {} }
  ) as unknown as {
    summary?: string;
    filesChanged?: string[];
    deviationsFromBrief?: unknown[];
    unresolved?: unknown[];
    extraSections?: Record<string, unknown>;
  };
  if (e.implementationReport === undefined) e.implementationReport = fallbackReport;

  const annotatorReport = (state as { structuredReport?: unknown }).structuredReport;
  if (annotatorReport && typeof annotatorReport === 'object') {
    enriched.structuredReport = annotatorReport as RuntimeRunResult['structuredReport'];
  } else if (enriched.structuredReport === undefined) {
    enriched.structuredReport = fallbackReport as RuntimeRunResult['structuredReport'];
  }

  // ── Mirror findings outcome fields from structuredReport onto envelope ──────
  const sr = enriched.structuredReport as any;
  if (sr?.findingsOutcome !== undefined) (enriched as any).findingsOutcome = sr.findingsOutcome;
  if (sr?.findingsOutcomeReason !== undefined) (enriched as any).findingsOutcomeReason = sr.findingsOutcomeReason;
  if (sr?.outcomeInferred !== undefined) (enriched as any).outcomeInferred = sr.outcomeInferred;
  if (sr?.outcomeMalformed !== undefined) (enriched as any).outcomeMalformed = sr.outcomeMalformed;

  // ── workerStatus derivation from output summary ─────────────────────────────
  if (enriched.workerStatus === undefined) {
    const summary = (fallbackReport?.summary ?? '').toLowerCase();
    if (last.status === 'error') enriched.workerStatus = 'failed';
    else if (summary.includes('changes_required') || summary.includes('blocked')) enriched.workerStatus = 'blocked';
    else if (summary.length > 0 || last.status === 'ok') enriched.workerStatus = 'done';
    else enriched.workerStatus = 'failed';
  }

  // ── models map ──────────────────────────────────────────────────────────────
  if (ctx && e.models === undefined) {
    const implModel = (ctx.implementerProvider?.config as { model?: string } | undefined)?.model ?? '';
    const otherTier = ctx.assignedTier === 'standard' ? 'complex' : 'standard';
    const otherProvider = ctx.providers[otherTier];
    const otherModel = (otherProvider?.config as { model?: string } | undefined)?.model ?? null;
    e.models = {
      implementer: implModel,
      specReviewer: e.specReviewStatus === 'approved' || e.specReviewStatus === 'changes_required' ? otherModel : null,
      qualityReviewer: e.qualityReviewStatus === 'approved' || e.qualityReviewStatus === 'changes_required' ? otherModel : null,
    };
  }

  // ── envelope-level reviewer notes / verdicts / errors / rework state ────────
  if (state.specReviewerNotes !== undefined) (enriched as { specReviewerNotes?: string }).specReviewerNotes = state.specReviewerNotes;
  if (state.qualityReviewerNotes !== undefined) (enriched as { qualityReviewerNotes?: string }).qualityReviewerNotes = state.qualityReviewerNotes;
  const reviewRp = reviewPayload(state);
  if (reviewRp.verdict !== undefined) {
    (enriched as { reviewVerdict?: string }).reviewVerdict = reviewRp.verdict;
    (enriched as { reviewFindings?: unknown }).reviewFindings = reviewRp.findings;
  }
  if (state.specReviewError !== undefined) (enriched as { specReviewError?: string }).specReviewError = state.specReviewError;
  if (state.qualityReviewError !== undefined) (enriched as { qualityReviewError?: string }).qualityReviewError = state.qualityReviewError;
  if (state.reviewError !== undefined) (enriched as { reviewError?: string }).reviewError = state.reviewError;
  if (state.reworkError !== undefined) (enriched as { reworkError?: string }).reworkError = state.reworkError;
  if (state.reworkOutput !== undefined) (enriched as { reworkOutput?: string }).reworkOutput = state.reworkOutput;
  if (state.reworkApplied !== undefined) (enriched as { reworkApplied?: boolean }).reworkApplied = state.reworkApplied;
  if (state.verifyResult !== undefined) (enriched as { verifyResult?: unknown }).verifyResult = state.verifyResult;

  // ── v5 M3 / M4 fixes: truthful workerSelfAssessment and rework-clears-up promo ─
  // ── workerSelfAssessment reconciliation (Fix C): objective-signal truth table ───
  const parsedCleanly = (last as any)?.parsedCleanly ?? false;
  const commitsFieldPresent = state.commits !== undefined;
  const commitsExist = Array.isArray(state.commits) && state.commits.length > 0;
  const commitKind = commitsExist ? (state.commits[0] as any)?.kind : undefined;
  const isCommitted = commitKind === 'committed';
  const verdictFieldPresent = reviewRp.verdict !== undefined;

  // Apply truth table: reconcile workerSelfAssessment against objective signals.
  // Only apply if both signals are present (commits field and verdict field set).
  // If either signal is absent, preserve parsed value.
  if (commitsFieldPresent && verdictFieldPresent && !parsedCleanly) {
    if (isCommitted && reviewRp.verdict === 'approved') {
      // false + committed + approved → done (with selfAssessmentReconciled)
      enriched.workerStatus = 'done';
      (enriched as any).selfAssessmentReconciled = true;
    } else if (isCommitted && reviewRp.verdict === 'changes_required') {
      // false + committed + changes_required → failed (preserved)
      enriched.workerStatus = 'failed';
    } else if (!isCommitted) {
      // false + no-commit (kind: 'no_op' or empty array) → failed
      enriched.workerStatus = 'failed';
    }
  }
  // parsedCleanly: true → preserve parsed value (no change)
  // missing-signal (commits absent or verdict absent) → preserve parsed value (no change)

  const reworkCleanedUp = state.reworkApplied === true && state.reworkError === undefined;
  const reviewRejected =
    state.reviewPolicy !== 'none' && reviewRp.verdict === 'changes_required' && !reworkCleanedUp;

  if (last.status === 'error') {
    enriched.status = 'error';
  } else if (reviewRejected) {
    enriched.status = 'incomplete';
    // Map review rejection to the canonical errorCode based on which
    // review sub-result returned changes_required. See error-codes.ts.
    const subResults = (state as { reviewSubResults?: Array<{ name: 'spec' | 'quality'; verdict: string }> }).reviewSubResults ?? [];
    const qualityRejected = subResults.some((r) => r.name === 'quality' && r.verdict === 'changes_required');
    const specRejected = subResults.some((r) => r.name === 'spec' && r.verdict === 'changes_required');
    if (qualityRejected) {
      enriched.errorCode = 'review_quality_findings_unresolved';
    } else if (specRejected) {
      enriched.errorCode = 'review_spec_rejected_terminal';
    } else {
      // Defensive: reviewVerdict === 'changes_required' but no sub-result
      // labelled itself. Fall back to the quality code (the most common path).
      enriched.errorCode = 'review_quality_findings_unresolved';
    }
    const priorTr = (typeof enriched.terminationReason === 'object' && enriched.terminationReason !== null)
      ? enriched.terminationReason
      : undefined;
    enriched.terminationReason = {
      cause: 'incomplete',
      turnsUsed: priorTr?.turnsUsed ?? last.turns ?? 0,
      hasFileArtifacts: priorTr?.hasFileArtifacts ?? (Array.isArray(last.filesWritten) && last.filesWritten.length > 0),
      usedShell: priorTr?.usedShell ?? false,
      workerSelfAssessment: ((last.workerStatus ?? state.workerStatus ?? null) as RuntimeRunResult['terminationReason'] extends { workerSelfAssessment: infer W } ? W : never),
      wasPromoted: false,
    };
  } else if (commitsExist) {
    enriched.status = 'ok';
  } else if (reworkCleanedUp && state.reviewPolicy !== 'none') {
    enriched.status = 'ok';
  }

  // Mirror the enriched object back into state.lastRunResult AND
  // state.responseEnvelope (legacy compose-target). emit_task_terminal +
  // recorder + headline composer read state.lastRunResult; the wire envelope
  // in DispatchOutput.finalState.lastRunResult ends up at the same place.
  state.lastRunResult = enriched;
  (state as { responseEnvelope?: unknown }).responseEnvelope = enriched;
}
