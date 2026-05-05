import type { ToolCategory } from '../escalation/escalation-policy.js';

export interface StageRow {
  rowId: string;
  stageName: string;
  schemaStage?: string;
  runCondition: (state: LifecycleState) => boolean;
  isRework: boolean;
  handlerKey: string;
}

export interface StagePlan {
  toolCategory: ToolCategory;
  rows: StageRow[];
}

export interface LifecycleState {
  terminal: boolean;
  workerStatus?: string;
  reviewVerdict?: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped';
  attemptIndex: number;
  attemptBudget: number;
  reviewPolicy: 'full' | 'quality_only' | 'diff_only' | 'none';
  shutdownInProgress: boolean;
  route?: string;
  toolCategory?: ToolCategory;
  // Per-row verdict slots (cascade semantics — undefined as shorting token):
  specReviewRound1Verdict?: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped';
  specReviewRound2Verdict?: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped';
  specReviewRound3Verdict?: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped';
  qualityReviewRound1Verdict?: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped' | 'annotated';
  qualityReviewRound2Verdict?: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped';
  qualityReviewRound3Verdict?: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped';
  diffReviewVerdict?: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped';
  // Chain-pass slots (set by LifecycleDriver after final round in chain returns 'approved' or
  // chain skipped via cascade; consumed by row 4.11 diff_review predicate):
  specChainPassed?: boolean;
  qualityChainPassed?: boolean;
  // ... other state fields
  [key: string]: unknown;
}
