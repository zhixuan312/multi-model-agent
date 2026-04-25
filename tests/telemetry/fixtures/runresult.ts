import type { RunResult } from '../../../packages/core/src/types.js';

const BASE_RUN_RESULT: RunResult = {
  output: 'Task completed successfully.',
  status: 'ok',
  usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700, costUSD: 0.005 },
  turns: 3,
  filesRead: ['/tmp/test/a.ts'],
  filesWritten: ['/tmp/test/b.ts'],
  toolCalls: ['read_file', 'edit_file', 'grep'],
  outputIsDiagnostic: false,
  escalationLog: [
    { provider: 'claude', status: 'ok', turns: 3, inputTokens: 500, outputTokens: 200, costUSD: 0.005, initialPromptLengthChars: 100, initialPromptHash: 'abc' },
  ],
  durationMs: 25_000,
  agents: {
    implementer: 'standard',
    implementerToolMode: 'full',
    specReviewer: 'standard',
    qualityReviewer: 'standard',
  },
  models: { implementer: 'claude-sonnet', specReviewer: 'claude-sonnet', qualityReviewer: 'claude-sonnet' },
  workerStatus: 'done',
  specReviewStatus: 'approved',
  qualityReviewStatus: 'approved',
  terminationReason: { cause: 'finished', turnsUsed: 3, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
  stageStats: {
    implementing:   { stage: 'implementing', entered: true, durationMs: 20_000, costUSD: 0.004, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
    verifying:      { stage: 'verifying', entered: true, durationMs: 2_000, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', outcome: 'passed', skipReason: null },
    spec_review:    { stage: 'spec_review', entered: true, durationMs: 1_000, costUSD: 0.001, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', verdict: 'approved', roundsUsed: 1 },
    spec_rework:    { stage: 'spec_rework', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null },
    quality_review: { stage: 'quality_review', entered: true, durationMs: 1_000, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', verdict: 'approved', roundsUsed: 1 },
    quality_rework: { stage: 'quality_rework', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null },
    diff_review:    { stage: 'diff_review', entered: true, durationMs: 500, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet', verdict: 'approved', roundsUsed: 1 },
    committing:     { stage: 'committing', entered: true, durationMs: 500, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
  },
};

// Per-route × terminal-status × pivotal flags fixtures
export const HAPPY: RunResult = structuredClone(BASE_RUN_RESULT);

export const INCOMPLETE: RunResult = {
  ...structuredClone(BASE_RUN_RESULT),
  status: 'incomplete',
  terminationReason: { cause: 'incomplete', turnsUsed: 2, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: null, wasPromoted: false },
  workerStatus: 'failed',
};

export const TIMEOUT: RunResult = {
  ...structuredClone(BASE_RUN_RESULT),
  status: 'timeout',
  terminationReason: { cause: 'timeout', turnsUsed: 5, hasFileArtifacts: false, usedShell: true, workerSelfAssessment: null, wasPromoted: false },
  workerStatus: 'failed',
};

export const ERROR_API: RunResult = {
  ...structuredClone(BASE_RUN_RESULT),
  status: 'api_error',
  terminationReason: { cause: 'api_error', turnsUsed: 1, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: null, wasPromoted: false },
  workerStatus: 'failed',
};

export const COST_EXCEEDED: RunResult = {
  ...structuredClone(BASE_RUN_RESULT),
  status: 'cost_exceeded',
  terminationReason: 'cost_ceiling' as unknown as RunResult['terminationReason'],
  workerStatus: 'failed',
  usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700, costUSD: 1.50 },
};

export const BRIEF_TOO_VAGUE: RunResult = {
  ...structuredClone(BASE_RUN_RESULT),
  status: 'brief_too_vague',
  terminationReason: { cause: 'brief_too_vague', turnsUsed: 0, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: null, wasPromoted: false },
  workerStatus: 'failed',
};

export const ESCALATED: RunResult = {
  ...structuredClone(BASE_RUN_RESULT),
  escalationLog: [
    { provider: 'claude', status: 'ok', turns: 2, inputTokens: 300, outputTokens: 100, costUSD: 0.002, initialPromptLengthChars: 100, initialPromptHash: 'a' },
    { provider: 'openai', status: 'ok', turns: 3, inputTokens: 500, outputTokens: 200, costUSD: 0.005, initialPromptLengthChars: 100, initialPromptHash: 'a' },
  ],
};

export const FALLBACK: RunResult = {
  ...structuredClone(BASE_RUN_RESULT),
  agents: {
    ...BASE_RUN_RESULT.agents,
    implementer: 'complex' as const,
    implementerHistory: ['standard' as const, 'complex' as const],
    specReviewer: 'standard',
    qualityReviewer: 'standard',
    fallbackOverrides: [{ role: 'implementer' as const, loop: 'spec' as const, attempt: 2, assigned: 'complex' as const, used: 'complex' as const, reason: 'not_configured' as const, bothUnavailable: false }],
  },
};

export const WITH_CONCERNS: RunResult = {
  ...structuredClone(BASE_RUN_RESULT),
  specReviewStatus: 'approved',
  concerns: [
    { source: 'spec_review', severity: 'minor' as const, message: 'no test for the new function' },
  ],
};

export const AUDIT_ROUTE_HAPPY: RunResult = {
  ...structuredClone(BASE_RUN_RESULT),
  stageStats: {
    implementing: { stage: 'implementing', entered: true, durationMs: 20_000, costUSD: 0.004, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
    verifying:    { stage: 'verifying', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, outcome: 'not_applicable', skipReason: 'not_applicable' },
    spec_review:  { stage: 'spec_review', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, verdict: 'not_applicable', roundsUsed: null },
    spec_rework:  { stage: 'spec_rework', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null },
    quality_review: { stage: 'quality_review', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, verdict: 'not_applicable', roundsUsed: null },
    quality_rework: { stage: 'quality_rework', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null },
    diff_review:  { stage: 'diff_review', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, verdict: 'not_applicable', roundsUsed: null },
    committing:   { stage: 'committing', entered: true, durationMs: 500, costUSD: 0, agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet' },
  } as RunResult['stageStats'],
};

export const NO_TERMINATION_REASON: RunResult = {
  ...structuredClone(BASE_RUN_RESULT),
  terminationReason: undefined,
  workerStatus: 'failed',
};

export const ROUND_CAP: RunResult = {
  ...structuredClone(BASE_RUN_RESULT),
  terminationReason: 'round_cap' as unknown as RunResult['terminationReason'],
  workerStatus: 'failed',
};

export interface FixtureEntry {
  name: string;
  route: 'delegate' | 'audit' | 'review' | 'verify' | 'debug' | 'execute-plan' | 'retry';
  terminal: string;
  input: RunResult;
}

export const ALL: FixtureEntry[] = [
  { name: 'happy_delegate', route: 'delegate', terminal: 'ok', input: HAPPY },
  { name: 'incomplete_delegate', route: 'delegate', terminal: 'incomplete', input: INCOMPLETE },
  { name: 'timeout_delegate', route: 'delegate', terminal: 'timeout', input: TIMEOUT },
  { name: 'error_delegate', route: 'delegate', terminal: 'error', input: ERROR_API },
  { name: 'cost_exceeded_delegate', route: 'delegate', terminal: 'cost_exceeded', input: COST_EXCEEDED },
  { name: 'brief_too_vague_delegate', route: 'delegate', terminal: 'brief_too_vague', input: BRIEF_TOO_VAGUE },
  { name: 'escalated_delegate', route: 'delegate', terminal: 'ok', input: ESCALATED },
  { name: 'fallback_delegate', route: 'delegate', terminal: 'ok', input: FALLBACK },
  { name: 'concerns_delegate', route: 'delegate', terminal: 'ok', input: WITH_CONCERNS },
  { name: 'audit_ok', route: 'audit', terminal: 'ok', input: AUDIT_ROUTE_HAPPY },
  { name: 'no_termination_reason', route: 'delegate', terminal: 'incomplete', input: NO_TERMINATION_REASON },
  { name: 'round_cap_delegate', route: 'delegate', terminal: 'incomplete', input: ROUND_CAP },
];
