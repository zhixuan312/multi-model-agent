import type { RuntimeRunResult } from '../../../../packages/core/src/types.js';

/** A RuntimeRunResult with non-zero data on every channel — every stage entered,
 *  every counter > 0, every list non-empty. Used by completeness tests. */
export function richRunResult(): RuntimeRunResult {
  return {
    output: 'rich worker output',
    status: 'ok',
    usage: { inputTokens: 1000, outputTokens: 200, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    cost: { costUSD: 0.05, costDeltaVsMainUSD: null },
    turns: 14,
    filesRead: ['src/a.ts', 'src/b.ts'],
    filesWritten: ['src/a.ts'],
    toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)'],
    directoriesListed: ['src'],
    outputIsDiagnostic: false,
    escalationLog: [
      { provider: 'standard', status: 'ok' as const, turns: 7, inputTokens: 500, outputTokens: 100, costUSD: 0.03, initialPromptLengthChars: 100, initialPromptHash: 'h1' },
      { provider: 'complex',  status: 'ok' as const, turns: 7, inputTokens: 500, outputTokens: 100, costUSD: 0.02, initialPromptLengthChars: 100, initialPromptHash: 'h2' },
    ],
    durationMs: 50000,
    workerStatus: 'done',
    terminationReason: { cause: 'finished', turnsUsed: 14, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
    commits: [
      { sha: 'abc', subject: 'feat: add x', body: '', filesChanged: ['src/a.ts', 'src/b.ts'], authoredAt: '2026-05-01T00:00:00Z' },
      { sha: 'def', subject: 'fix: y',     body: '', filesChanged: ['src/a.ts'],              authoredAt: '2026-05-01T00:01:00Z' },
    ],
    // v4.4.x findings surface lives on structuredReport. reviewConcerns
    // (string[]) is the canonical write-route surface; the wire builder
    // projects each into a medium-severity finding (default per-finding
    // severity for reviewer output, which doesn't carry per-clause severity).
    structuredReport: {
      reviewConcerns: ['concern 1', 'concern 2', 'concern 3'],
    } as any,
    specReviewStatus: 'approved',
    qualityReviewStatus: 'approved',
    reviewVerdict: 'approved',
    reviewRounds: { spec: 2, quality: 2, metadata: 0, cap: 3 },
    stageStats: {
      implementing: { stage: 'implementing', entered: true, durationMs: 30000, costUSD: 0.03, agentTier: 'standard', modelFamily: 'openai', model: 'gpt-5', maxIdleMs: 1000, totalIdleMs: 5000, activityEvents: 20, inputTokens: 500, outputTokens: 100, cachedReadTokens: 30, cachedNonReadTokens: 25, round: 1, turnCount: 7, toolCallCount: 4, filesReadCount: 2, filesWrittenCount: 1 },
      review:       { stage: 'review',       entered: true, durationMs: 10000, costUSD: 0.010, agentTier: 'complex',  modelFamily: 'openai', model: 'claude-sonnet', maxIdleMs: 500, totalIdleMs: 2000, activityEvents: 8, inputTokens: 400, outputTokens: 100, cachedReadTokens: 24, cachedNonReadTokens: 20, round: 1, turnCount: 2, toolCallCount: 2, filesReadCount: 2, filesWrittenCount: 0, verdict: 'approved' as const, roundsUsed: 2 },
      rework:       { stage: 'rework',       entered: true, durationMs: 6000,  costUSD: 0.006, agentTier: 'complex',  modelFamily: 'openai', model: 'claude-sonnet', maxIdleMs: 400, totalIdleMs: 1000, activityEvents: 6, inputTokens: 200, outputTokens: 60, cachedReadTokens: 6, cachedNonReadTokens: 10, round: 1, turnCount: 4, toolCallCount: 2, filesReadCount: 2, filesWrittenCount: 2 },
      annotating:   { stage: 'annotating',   entered: true, durationMs: 2000,  costUSD: 0.001, agentTier: 'standard', modelFamily: 'openai', model: 'gpt-5', maxIdleMs: 100, totalIdleMs: 200, activityEvents: 2, inputTokens: null, outputTokens: null, cachedReadTokens: null, cachedNonReadTokens: null, round: 1, turnCount: null, toolCallCount: 1, filesReadCount: 1, filesWrittenCount: 1, outcome: 'passed' as const, skipReason: null },
      committing:   { stage: 'committing',   entered: true, durationMs: 500,   costUSD: 0.001, agentTier: 'standard', modelFamily: 'openai', model: 'gpt-5', maxIdleMs: 50,  totalIdleMs: 100, activityEvents: 1, inputTokens: null, outputTokens: null, cachedReadTokens: null, cachedNonReadTokens: null, round: 1, turnCount: null, toolCallCount: 1, filesReadCount: 1, filesWrittenCount: 1 },
    },
    models: { implementer: 'gpt-5', specReviewer: 'claude-sonnet', qualityReviewer: 'claude-sonnet' },
    agents: { implementer: 'standard', implementerToolMode: 'full', specReviewer: 'standard', qualityReviewer: 'standard', fallbackOverrides: [{ role: 'implementer' as const, loop: 'spec' as const, attempt: 0, assigned: 'complex' as const, used: 'complex' as const, reason: 'unavailable' as const, triggeringStatus: undefined, bothUnavailable: false }] },
    taskMaxIdleMs: 1000,
    stallCount: 1,
    sandboxViolationCount: 1,
  } as RuntimeRunResult;
}
