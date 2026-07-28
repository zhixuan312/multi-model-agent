import type { PipelineResult, AgentType, TaskType } from '@zhixuan92/multi-model-agent-core';
import type { TaskEnvelope, StageRecord, Route } from '@zhixuan92/multi-model-agent-core/events/task-envelope';

/** Map unified TaskType (underscores) to wire Route (hyphens). */
export function taskTypeToRoute(type: TaskType): Route {
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
): TaskEnvelope {
  const now = new Date().toISOString();
  const route = taskTypeToRoute(type);

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
      verdict: result.status === 'done_with_concerns' ? 'concerns' : 'approved',
      concernCategories: [],
    });
  }

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
    reviewPolicy: reviewPolicy === 'none' ? 'none' : 'reviewed',
    plannedStageTotal: stages.length,
    stages,
    toolCalls: [],
    filesWritten: implTurn.filesWritten,
    realFilesChanged: implTurn.filesWritten,
    commitSha: null,
    commitMessage: null,
    commitSkipReason: null,
    contextBlockId: null,
    totalCostUSD,
    totalInputTokens,
    totalOutputTokens,
    totalCachedReadTokens: totalCachedRead,
    totalCachedNonReadTokens: totalCachedNonRead,
    totalDurationMs: durationMs,
    turnsUsed: stages.reduce((s, st) => s + st.turnsUsed, 0),
    stallCount: 0,
    sandboxViolationCount: 0,
    taskMaxIdleMs: 0,
    findings: [],
    sourcesUsed,
    escalationLog: [],
    validationWarnings: [],
    headline: { prefix: '', stageLabel: 'done', stageIndex: stages.length, stageTotal: stages.length, toolWrites: 0, toolTotal: 0 },
  };
}
