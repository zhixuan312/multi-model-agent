export type FieldCoverage =
  | { kind: 'derived'; source: string }
  | { kind: 'constant'; reason: string }
  | { kind: 'unavailable'; targetVersion: string; reason: string }
  | { kind: 'not_applicable'; reason: string };

export const TASK_COMPLETED_FIELD_COVERAGE: Record<string, FieldCoverage> = {
  eventId:                  { kind: 'derived', source: 'randomUUID() per build' },
  route:                    { kind: 'derived', source: 'BuildContext.route' },
  client:                   { kind: 'derived', source: 'BuildContext.client' },
  agentType:                { kind: 'derived', source: 'runResult.agents.implementer' },
  toolMode:                 { kind: 'derived', source: 'runResult.agents.implementerToolMode' },
  capabilities:             { kind: 'derived', source: 'runResult.agents.implementerCapabilities' },
  reviewPolicy:             { kind: 'derived', source: 'BuildContext.reviewPolicy or route default' },
  verifyCommandPresent:     { kind: 'derived', source: 'BuildContext.verifyCommandPresent' },
  implementerModel:         { kind: 'derived', source: 'runResult.models.implementer (normalized)' },
  terminalStatus:           { kind: 'derived', source: 'runResult.terminationReason' },
  workerStatus:             { kind: 'derived', source: 'runResult.workerStatus' },
  errorCode:                { kind: 'derived', source: 'runResult.error / status' },
  parentModelFamily:        { kind: 'derived', source: 'BuildContext.parentModel (normalized)' },
  inputTokens:              { kind: 'derived', source: 'sum(stages[].inputTokens)' },
  outputTokens:             { kind: 'derived', source: 'sum(stages[].outputTokens)' },
  cachedTokens:             { kind: 'derived', source: 'sum(stages[].cachedTokens)' },
  reasoningTokens:          { kind: 'derived', source: 'sum(stages[].reasoningTokens)' },
  totalDurationMs:          { kind: 'derived', source: 'runResult.durationMs ?? sum(stages[].durationMs)' },
  totalCostUSD:             { kind: 'derived', source: 'sum(stages[].costUSD)' },
  costDeltaVsParentUSD:        { kind: 'derived', source: 'computeCostDeltaVsParentUSD(totals, parentModel)' },
  concernCount:             { kind: 'derived', source: 'min(runResult.concerns.length, 150)' },
  escalationCount:          { kind: 'derived', source: 'distinctProviders(escalationLog) - 1, capped at 20' },
  fallbackCount:            { kind: 'derived', source: 'min(runResult.agents.fallbackOverrides.length, 20)' },
  stallCount:               { kind: 'derived', source: 'runResult.stallCount or stallTriggered' },
  taskMaxIdleMs:            { kind: 'derived', source: 'runResult.taskMaxIdleMs' },
  clarificationRequested:   { kind: 'derived', source: 'runResult.lifecycleClarificationRequested' },
  briefQualityWarningCount: { kind: 'derived', source: 'min(runResult.briefQualityWarnings.length, 20)' },
  sandboxViolationCount:    { kind: 'derived', source: 'min(runResult.sandboxViolationCount, 100)' },
  stages:                   { kind: 'derived', source: 'buildStages(route, runResult)' },
  validation_warnings:      { kind: 'derived', source: 'recorder from schema validation (absent when healthy)' },
};

const COMMON_STAGE_COVERAGE: Record<string, FieldCoverage> = {
  model:               { kind: 'derived', source: 'stageStats[name].model' },
  agentTier:           { kind: 'derived', source: 'stageStats[name].agentTier' },  // values: 'standard' | 'complex'
  durationMs:          { kind: 'derived', source: 'stageStats[name].durationMs' },
  costUSD:             { kind: 'derived', source: 'stageStats[name].costUSD' },
  inputTokens:         { kind: 'derived', source: 'stageStats[name].inputTokens' },
  outputTokens:        { kind: 'derived', source: 'stageStats[name].outputTokens' },
  cachedTokens:        { kind: 'derived', source: 'stageStats[name].cachedTokens' },
  reasoningTokens:     { kind: 'derived', source: 'stageStats[name].reasoningTokens' },
  toolCallCount:       { kind: 'derived', source: 'stageStats[name].toolCallCount' },
  filesReadCount:      { kind: 'derived', source: 'stageStats[name].filesReadCount' },
  filesWrittenCount:   { kind: 'derived', source: 'stageStats[name].filesWrittenCount' },
  turnCount:           { kind: 'derived', source: 'stageStats[name].turnCount' },
  maxIdleMs:           { kind: 'derived', source: 'stageStats[name].maxIdleMs' },
  totalIdleMs:         { kind: 'derived', source: 'stageStats[name].totalIdleMs' },
};

export const STAGE_FIELD_COVERAGE: Record<string, Record<string, FieldCoverage>> = {
  implementing: { ...COMMON_STAGE_COVERAGE },
  spec_review: {
    ...COMMON_STAGE_COVERAGE,
    verdict:             { kind: 'derived', source: 'specReviewStatus' },
    roundsUsed:          { kind: 'derived', source: 'reviewRounds.spec' },
    concernCategories:   { kind: 'derived', source: 'concerns.filter(spec_review).map(classifyConcern)' },
    findingsBySeverity:  { kind: 'derived', source: 'concerns.filter(spec_review).groupBy(severity)' },
  },
  quality_review: {
    ...COMMON_STAGE_COVERAGE,
    verdict:             { kind: 'derived', source: 'qualityReviewStatus' },
    roundsUsed:          { kind: 'derived', source: 'reviewRounds.quality' },
    concernCategories:   { kind: 'derived', source: 'concerns.filter(quality_review).map(classifyConcern)' },
    findingsBySeverity:  { kind: 'derived', source: 'concerns.filter(quality_review).groupBy(severity)' },
  },
  diff_review: {
    ...COMMON_STAGE_COVERAGE,
    verdict:             { kind: 'derived', source: 'diffReviewStatus' },
    roundsUsed:          { kind: 'constant', reason: 'diff_review never reworks; always 1 when entered' },
    concernCategories:   { kind: 'derived', source: 'concerns.filter(diff_review).map(classifyConcern)' },
    findingsBySeverity:  { kind: 'derived', source: 'concerns.filter(diff_review).groupBy(severity)' },
  },
  spec_rework: {
    ...COMMON_STAGE_COVERAGE,
    triggeringConcernCategories: { kind: 'derived', source: 'concerns.filter(spec_review).map(classifyConcern)' },
  },
  quality_rework: {
    ...COMMON_STAGE_COVERAGE,
    triggeringConcernCategories: { kind: 'derived', source: 'concerns.filter(quality_review).map(classifyConcern)' },
  },
  verifying: {
    ...COMMON_STAGE_COVERAGE,
    inputTokens:     { kind: 'constant', reason: 'verify runs shell commands, not LLM — no tokens' },
    outputTokens:    { kind: 'constant', reason: 'verify runs shell commands, not LLM — no tokens' },
    cachedTokens:    { kind: 'constant', reason: 'verify runs shell commands, not LLM — no tokens' },
    reasoningTokens: { kind: 'constant', reason: 'verify runs shell commands, not LLM — no tokens' },
    turnCount:       { kind: 'constant', reason: 'verify runs shell commands, not LLM — no turns' },
    outcome:         { kind: 'derived', source: 'verifyStageResult.status' },
    skipReason:      { kind: 'derived', source: 'verifyStageResult.skipReason' },
  },
  committing: {
    ...COMMON_STAGE_COVERAGE,
    inputTokens:         { kind: 'constant', reason: 'commit stage runs git commands, not LLM — no tokens' },
    outputTokens:        { kind: 'constant', reason: 'commit stage runs git commands, not LLM — no tokens' },
    cachedTokens:        { kind: 'constant', reason: 'commit stage runs git commands, not LLM — no tokens' },
    reasoningTokens:     { kind: 'constant', reason: 'commit stage runs git commands, not LLM — no tokens' },
    turnCount:           { kind: 'constant', reason: 'commit stage runs git commands, not LLM — no turns' },
    filesCommittedCount: { kind: 'derived', source: 'commitResult.filesCommittedCount' },
    branchCreated:       { kind: 'derived', source: 'commitResult.branchCreated' },
  },
};
