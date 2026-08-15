import type { PipelineResult, AgentType, TaskType } from '@zhixuan92/multi-model-agent-core';
import type { TaskEnvelope, StageRecord, Route } from '@zhixuan92/multi-model-agent-core/events/task-envelope';
import {
  extractReviewerFindings,
  findingCategories,
  deriveFindingsOutcome,
  FINDINGS_ROUTES,
} from './reviewer-findings.js';

/**
 * Sum the values that were actually measured; null when none were.
 *
 * Guards on `typeof === 'number'` rather than `!== null`, which is not
 * pedantry: `undefined` passes a null check and then poisons the sum to NaN,
 * and NaN reaches the wire as a schema violation that drops the whole event.
 */
function sumMeasured(values: (number | null | undefined)[]): number | null {
  const measured = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return measured.length === 0 ? null : measured.reduce((a, b) => a + b, 0);
}

/** Map unified TaskType (underscores) to wire Route (hyphens). */
function taskTypeToRoute(type: TaskType): Route {
  const map: Record<string, Route> = {
    execute_plan: 'execute-plan',
    journal_recall: 'journal-recall',
    journal_record: 'journal-record',
  };
  return (map[type] ?? type) as Route;
}

/**
 * Build a minimal TaskEnvelope-compatible snapshot from a PipelineResult
 * so the TelemetryUploader can convert it to a wire record and enqueue it.
 */
export function buildEnvelopeSnapshot(
  taskId: string,
  type: TaskType,
  result: PipelineResult,
  implTier: AgentType,
  revTier: AgentType,
  reviewPolicy: 'reviewed' | 'none',
  implModel: string,
  revModel: string,
  mainModel: string,
  client: string,
  cwd: string,
  durationMs: number,
  sourcesUsed: TaskEnvelope['sourcesUsed'] = [],
  wasCancelled = false,
): TaskEnvelope {
  const now = new Date().toISOString();
  const route = taskTypeToRoute(type);

  // The reviewer's findings, lifted off its parsed output. Computed here rather
  // than at the `findings:` field below because the review stage needs them too
  // — its verdict, categories and severity histogram all describe this same
  // list, and deriving them twice is how they drift apart.
  const findings = extractReviewerFindings(result.reviewerOutput);
  const findingsOutcome = deriveFindingsOutcome(
    findings,
    result.reviewerTurn !== null,
    FINDINGS_ROUTES.has(type),
  );

  // Build stage records from the pipeline turns.
  const stages: StageRecord[] = [];
  const implTurn = result.implementerTurn;
  stages.push({
    name: 'implementing',
    round: 1,
    outcome: result.status === 'failed' ? 'fail' : 'advance',
    startedAt: now,
    completedAt: now,
    durationMs: implTurn.durationMs,
    costUSD: implTurn.costUSD,
    model: implModel,
    tier: implTier,
    turnsUsed: implTurn.turns,
    filesWrittenCount: implTurn.filesWritten.length,
    inputTokens: implTurn.usage.inputTokens,
    outputTokens: implTurn.usage.outputTokens,
    cachedReadTokens: implTurn.usage.cachedReadTokens,
    cachedNonReadTokens: implTurn.usage.cachedNonReadTokens,
    // Carried here ONLY when no reviewer ran, so the rollup (review >
    // implementing) still finds one. Without it an unreviewed task reports no
    // outcome at all, and "no outcome" and "reviewed, nothing found" are then
    // indistinguishable downstream — the same collapse this field exists to
    // prevent. The review stage below overrides it whenever it exists.
    ...(result.reviewerTurn ? {} : { findingsOutcome }),
  });

  if (result.reviewerTurn) {
    const revTurn = result.reviewerTurn;
    stages.push({
      name: 'reviewing',
      round: 1,
      outcome: result.status === 'done_with_concerns' ? 'concern' : 'advance',
      startedAt: now,
      completedAt: now,
      durationMs: revTurn.durationMs,
      costUSD: revTurn.costUSD,
      model: revModel,
      tier: revTier,
      turnsUsed: revTurn.turns,
      filesWrittenCount: 0,
      inputTokens: revTurn.usage.inputTokens,
      outputTokens: revTurn.usage.outputTokens,
      cachedReadTokens: revTurn.usage.cachedReadTokens,
      cachedNonReadTokens: revTurn.usage.cachedNonReadTokens,
      // The verdict follows the findings, not just the pipeline status. A
      // reviewer that raised critical or high findings has demanded changes
      // even when the pipeline let the answer stand, and reporting that as
      // `approved` is what made the review stage look uniformly happy.
      verdict:
        findings.some((f) => f.severity === 'critical' || f.severity === 'high')
          ? 'changes_required'
          : result.status === 'done_with_concerns' || findings.length > 0
            ? 'concerns'
            : 'approved',
      concernCategories: findingCategories(findings),
      findingsBySeverity: findings.reduce(
        (acc, f) => ({ ...acc, [f.severity]: acc[f.severity] + 1 }),
        { critical: 0, high: 0, medium: 0, low: 0 },
      ),
      findingsOutcome,
    });
  }

  // Project each runner's per-call toolCalls onto envelope ToolCallRecords,
  // tagged with the owning stage. filesWritten stays empty here — runners
  // report toolCalls as { turn, tool } only (no per-call file attribution);
  // the turn-level file set already lands in stages[].filesWrittenCount /
  // env.filesWritten via implTurn.filesWritten, so nothing is lost.
  const toolCalls: TaskEnvelope['toolCalls'] = [
    ...implTurn.toolCalls.map((tc) => ({ ts: now, stage: 'implementing', turn: tc.turn, tool: tc.tool, filesWritten: [] })),
    ...(result.reviewerTurn?.toolCalls.map((tc) => ({ ts: now, stage: 'reviewing', turn: tc.turn, tool: tc.tool, filesWritten: [] })) ?? []),
  ];

  const totalInputTokens = stages.reduce((s, st) => s + st.inputTokens, 0);
  const totalOutputTokens = stages.reduce((s, st) => s + st.outputTokens, 0);
  const totalCachedRead = stages.reduce((s, st) => s + (st.cachedReadTokens ?? 0), 0);
  const totalCachedNonRead = stages.reduce((s, st) => s + (st.cachedNonReadTokens ?? 0), 0);
  const totalCostUSD = stages.reduce((s, st) => s + (st.costUSD ?? 0), 0);

  return {
    taskId,
    batchId: taskId,
    taskIndex: 0,
    route,
    agentType: implTier,
    client,
    mainModel,
    cwd,
    startedAt: now,
    status: result.status,
    terminalAt: now,
    stopReason: null,
    structuredError: result.status === 'failed'
      ? (result.failureReason ?? { code: 'pipeline_failed', message: 'Pipeline completed with failed status' })
      : null,
    errorCode: null,
    reviewPolicy,
    stages,
    toolCalls,
    // Two DIFFERENT facts, and they were both being filled from the worker's self-report.
    // `filesWritten` is what the runner says it touched; `realFilesChanged` is
    // `git diff --name-only` across the engine's commit — the field `to-wire-record` turns into
    // `filesWrittenCount`. Falls back to the self-report only when there is no git answer at all
    // (read routes, non-git targets, nothing committed).
    filesWritten: implTurn.filesWritten,
    realFilesChanged: result.filesChangedFromGit ?? implTurn.filesWritten,
    // The envelope's own comment said these are "set at seal() from the commit gate payload" —
    // a mechanism retired with the lifecycle layer, after which this hardcoded null and every
    // write-route execution reported "no commit" in telemetry. The pipeline carries the
    // commit-time SHA; take it.
    commitSha: result.commitSha,
    // The engine composes its commit message internally and does not surface it on
    // `PipelineResult`, so there is nothing honest to put here yet.
    commitMessage: null,
    commitSkipReason: null,
    contextBlockId: null,
    wasCancelled,
    totalCostUSD,
    totalInputTokens,
    totalOutputTokens,
    totalCachedReadTokens: totalCachedRead,
    totalCachedNonReadTokens: totalCachedNonRead,
    totalDurationMs: durationMs,
    turnsUsed: stages.reduce((s, st) => s + st.turnsUsed, 0),
    // Null only when NO stage could measure — one measurable stage makes the
    // task's count meaningful. Treating a null stage as 0 inside a mixed task
    // would understate; treating the whole task as null would discard a real
    // observation. Sum what was measured, report null when nothing was.
    sandboxViolationCount: sumMeasured([
      implTurn.sandboxDenialCount,
      result.reviewerTurn?.sandboxDenialCount ?? null,
    ]),
    findings,
    sourcesUsed,
    validationWarnings: [],
  };
}
