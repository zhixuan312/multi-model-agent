// Task envelope — the structured shape describing a single task's lifecycle.
// Types are defined locally to decouple events/ from types/run-result.
//
// Production builds a TaskEnvelope in one shot via buildEnvelopeSnapshot()
// (packages/server/src/http/handlers/unified-task.ts); to-wire-record.ts and the
// envelope bus consume it. A step-by-step builder for these types lives in the
// test fixtures (tests/fixtures/task-envelope-store.ts) and has no production use.

import type { ErrorCode } from '../error-codes.js';
import type { FindingsOutcome } from '../types/enums.js';

export interface StructuredError { code: string; message: string; where?: string }
export interface Finding { id: string; severity: 'critical'|'high'|'medium'|'low'; category: string; claim: string; evidence: string; suggestion?: string; source: 'implementer'|'reviewer' }
export interface EscalationEntry { fromModel: string; toModel: string; reason: string; atStage?: string }
export interface ValidationWarning { rule: string; path: string }

export type Route = 'delegate' | 'audit' | 'review' | 'debug' | 'investigate' | 'execute-plan' | 'research' | 'journal-record' | 'journal-recall' | 'orchestrate' | 'spec' | 'plan';
export type EnvelopeStatus = 'running' | 'done' | 'done_with_concerns' | 'failed';
export type StageName = 'implementing' | 'reviewing' | 'reworking' | 'annotating' | 'committing';
export type AgentTier = 'standard' | 'complex' | 'main';

export interface StageRecord {
  name: StageName;
  round: number;
  outcome: 'advance' | 'concern' | 'fail' | 'skipped' | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  costUSD: number | null;
  model: string;
  tier: AgentTier;
  turnsUsed: number;
  filesWrittenCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number | null;
  cachedNonReadTokens: number | null;
  // route-specific (closed set per spec)
  filesCommittedCount?: number;
  branchCreated?: boolean;
  skipReason?: 'noop' | 'no_command' | 'not_applicable' | 'reviewPolicy_none';
  // Stage verdicts:
  //   review stage → 'approved' | 'changes_required' | 'error' (combined verdict
  //     of spec + quality sub-reviewers; matches wire enum, see wire-schema.ts).
  //   committing / verify stages → 'passed' | 'failed' | 'no_command' | 'annotated'
  //   annotating stage → tracked separately via `outcome` not `verdict`
  verdict?: 'passed' | 'failed' | 'no_command' | 'annotated' | 'approved' | 'changes_required' | 'concerns' | 'error';
  findingsBySeverity?: { critical: number; high: number; medium: number; low: number };
  concernCategories?: string[];
  // Findings outcome threading (review + implementing stages)
  findingsOutcome?: FindingsOutcome | null;
  findingsOutcomeReason?: string | null;
  outcomeInferred?: boolean;
  outcomeMalformed?: boolean;
}

export interface ToolCallRecord {
  ts: string;
  stage: string;
  tool: string;
  filesWritten: string[];
}

export interface HeadlineSnapshot {
  prefix: string;
  stageLabel: string;
  // 1-based ordinal of the stage named by stageLabel — i.e. how many visible
  // stages have *started* (the running one counts). Mirrors the heartbeat's
  // visibleRan, so `[stageIndex/stageTotal] stageLabel` reads as "stage N of
  // M, currently <label>". Not a count of completed stages.
  stageIndex: number;
  stageTotal: number;
  toolWrites: number;
  toolTotal: number;
}

export interface TaskEnvelope {
  // identity (immutable after creation)
  taskId: string;
  batchId: string;
  taskIndex: number;
  route: Route;
  agentType: AgentTier;
  client: string;
  mainModel: string;
  cwd: string;
  startedAt: string;
  // status
  status: EnvelopeStatus;
  terminalAt: string | null;
  stopReason: string | null;
  structuredError: StructuredError | null;
  errorCode: ErrorCode | null;
  reviewPolicy: 'reviewed' | 'none';
  plannedStageTotal: number;
  // accumulated
  stages: StageRecord[];
  toolCalls: ToolCallRecord[];
  filesWritten: string[];
  realFilesChanged: string[];
  // commit outcome (write routes) — set at seal() from the commit gate payload.
  // The response's structuredReport reads these so committed tasks surface their
  // real SHA/message; null on read routes and skipped commits.
  commitSha: string | null;
  commitMessage: string | null;
  commitSkipReason: string | null;
  // terminal context block (read routes) — set at seal() from the registered
  // terminal-report block id; null on write routes and on registration failure.
  contextBlockId: string | null;
  // totals
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedReadTokens: number;
  totalCachedNonReadTokens: number;
  totalDurationMs: number;
  turnsUsed: number;
  stallCount: number;
  sandboxViolationCount: number;
  taskMaxIdleMs: number;
  // findings/diagnostics
  findings: Finding[];
  // research-only: the `## Sources used` table (which adapter groups were
  // queried and which returned data), set at compose from the EvidencePack.
  // Empty on every non-research route.
  sourcesUsed: { source: string; attempted: boolean; used: boolean; note?: string }[];
  escalationLog: EscalationEntry[];
  validationWarnings: ValidationWarning[];
  // derived
  headline: HeadlineSnapshot;
}
