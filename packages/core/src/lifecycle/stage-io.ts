// One canonical place for stage I/O contracts. Imported by stage-plan-builder,
// lifecycle-driver, every handler, and compose.

export type RouteName =
  | 'delegate' | 'execute-plan'
  | 'audit' | 'review' | 'debug' | 'investigate' | 'explore'
  | 'register-context-block';

export const ALL_TASK_ROUTES = ['delegate', 'execute-plan', 'audit', 'review', 'debug', 'investigate', 'explore'] as const;

export const WRITE_ROUTES = ['delegate', 'execute-plan'] as const;

export type WorkerSelfAssessment = 'done' | 'failed';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type Finding = {
  id: string;
  severity: Severity;
  category: string;
  claim: string;
  evidence?: string;
  suggestion?: string;
  source: 'implementer' | 'reviewer';
};

export type Citation = { file: string; lines: string; claim: string };
export type Validation = { name: string; passed: boolean; output: string };

// ───── Per-stage payloads ─────

export type RegisterBlockPayload = { blockId: string; bytes: number };

export type ImplementPayload = {
  workerSelfAssessment: WorkerSelfAssessment;
  summary: string;
  // write-route outputs (read leaves at default)
  filesChanged: string[];
  // read-route outputs (write leaves at default)
  findings: Finding[];
  citations: Citation[];
  criteriaSucceeded: string[];
  criteriaErrors: Array<{ criterion: string; error: string }>;
  sourcesUsed: string[];
};

export type ReviewPayload = {
  verdict: 'approved' | 'changes_required';
  findings: Finding[];                                    // source: 'reviewer'
  reviewersSucceeded: Array<'spec' | 'quality'>;
  reviewersErrored: Array<{ reviewer: 'spec' | 'quality'; error: string }>;
};

export type ReworkPayload = {
  workerSelfAssessment: WorkerSelfAssessment;
  summary: string;
  filesChanged: string[];
  unaddressedFindingIds: string[];
};

export type CommitPayload =
  | { kind: 'committed';
      commitSha: string;
      commitMessage: string;
      filesChanged: string[];
      authoredAt: string;
    }
  | { kind: 'no_op';
      reason: 'no_repo' | 'no_diff' | 'worker_committed_out_of_band' | 'hook_failed';
      detail?: string;
    };

export type AnnotatePayload = {
  completed: boolean;
  message: string;
  findings: Finding[];
  summary: string;
  filesChanged: string[];
  commitSha: string | null;
};

export type ComposePayload = {
  // main-agent slice (7 fields)
  completed: boolean;
  message: string;
  findings: Finding[];
  summary: string;
  filesChanged: string[];
  commitSha: string | null;
  blockId: string | null;
  // telemetry slice
  telemetry: {
    totalDurationMs: number;
    totalCostUSD: number | null;
    workerSelfAssessment: WorkerSelfAssessment | null;
    reviewVerdict: 'approved' | 'changes_required' | null;
    commitOutcome: 'committed' | 'no_op' | 'not_applicable';
    stopReason: 'normal' | 'turn_cap' | 'cost_cap' | 'timeout' | 'transport_error';
    haltedStage: string | null;
    stages: Array<{
      name: string;
      outcome: 'advance' | 'skip' | 'halt' | 'not_run';
      comment?: string;
      durationMs: number;
      costUSD: number | null;
    }>;
  };
};

export type TerminalPayload = {
  terminalBlockId: string | null;
  telemetryFlushed: boolean;
  batchRegistryPersisted: boolean;
  taskTerminalEmitted: boolean;
  projectCleanupTicked: boolean;
};

// ───── Driver runtime types ─────

export type StageStopReason =
  'normal' | 'turn_cap' | 'cost_cap' | 'timeout' | 'transport_error';

export type StageGate<TPayload = unknown> = {
  outcome: 'advance' | 'skip' | 'halt';
  comment?: string;
  payload: TPayload;
  telemetry: {
    stageLabel: string;
    durationMs: number;
    costUSD: number | null;
    turnsUsed: number;
    stopReason: StageStopReason;
  };
};

export type EntryDecision = { run: true } | { run: false; comment: string };

// LifecycleState is defined in stage-plan-types.ts; we re-import here for the
// StageDefinition signature.
import type { LifecycleState } from './stage-plan-types.js';

export type StageDefinition<TPayload = unknown> = {
  name: string;
  runOnHalt: boolean;
  applicableRoutes: 'all' | RouteName[];
  shouldRun: (state: LifecycleState) => EntryDecision;
  handler: (state: LifecycleState) => Promise<StageGate<TPayload>>;
};

// ───── Helpers ─────

/** Canonical "current work artifact" lookup used by commit/annotate/compose. */
export function currentWork(state: { gates: Record<string, StageGate<unknown>> }):
  ImplementPayload | ReworkPayload | null
{
  const rework = state.gates['rework'];
  if (rework?.outcome === 'advance') return rework.payload as ReworkPayload;
  const implement = state.gates['implement'];
  if (implement?.outcome === 'advance') return implement.payload as ImplementPayload;
  return null;
}