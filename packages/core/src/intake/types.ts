import type { TaskSpec } from '../types.js';

export type BriefQualityWarning =
  | 'outsourced_discovery'
  | 'brittle_line_anchors'
  | 'mixed_environment_actions'
  | 'bare_topic_noun'
  | 'no_done_condition'
  | 'no_output_contract'
  | 'tiny_brief'
  | 'huge_brief';

export type BriefQualityPolicy = 'strict' | 'warn' | 'off' | undefined;

export interface ReadinessResult {
  action: 'refuse' | 'warn' | 'ignored'
  missingPillars: ('scope' | 'inputs' | 'done_condition' | 'output_contract')[]
  layer2Warnings: BriefQualityWarning[]
  layer3Hints: ('concrete_path' | 'named_code_artifact' | 'reasonable_length')[]
  briefQualityWarnings: BriefQualityWarning[]
}

export type SourceRoute = 'delegate_tasks' | 'review_code' | 'debug_task' | 'verify_work' | 'audit_document' | 'execute_plan' | 'investigate_codebase';

export type DelegateSource = { route: 'delegate_tasks'; originalInput: Record<string, unknown> };
export type ReviewSource = { route: 'review_code'; originalInput: Record<string, unknown>; code?: string; inlineContent?: string; focus?: string[] };
export type DebugSource = { route: 'debug_task'; originalInput: Record<string, unknown>; problem: string; context?: string; hypothesis?: string };
export type VerifySource = { route: 'verify_work'; originalInput: Record<string, unknown>; checklist: string[]; work?: string };
export type AuditSource = { route: 'audit_document'; originalInput: Record<string, unknown>; document?: string; auditType?: string };
export type ExecutePlanSource = { route: 'execute_plan'; originalInput: Record<string, unknown>; filePaths: string[]; task: string };
export type InvestigateSource = { route: 'investigate_codebase'; originalInput: Record<string, unknown>; question: string; filePaths: string[] };
export type AnySource = DelegateSource | ReviewSource | DebugSource | VerifySource | AuditSource | ExecutePlanSource | InvestigateSource;

export interface DraftTask {
  draftId: string;
  source: AnySource;
  prompt: string;
  done?: string;
  filePaths?: string[];
  agentType?: string;
  assumptions?: string[];
  questions?: string[];
  confirmed?: boolean;
  contextBlockIds?: string[];
  reviewPolicy?: 'full' | 'spec_only' | 'diff_only' | 'off';
  skipCompletionHeuristic?: boolean;
}

export interface StoredDraft {
  draft: DraftTask;
  taskIndex: number;
  roundCount: number;
  previousReasons?: string[];
}

export interface ClarificationSet {
  id: string;
  drafts: Map<string, StoredDraft>;
  originalBatchId: string;
  executedDraftIds: Set<string>;
  createdAt: number;
  lastAccessedAt: number;
}

export interface ConfirmationEntry {
  prompt: string;
  filePaths?: string[];
  done?: string;
}

export interface ConfirmDraftError {
  draftId: string;
  errorCode: string;
  message: string;
}

export interface ConfirmResult {
  confirmedDrafts: DraftTask[];
  errors: ConfirmDraftError[];
  executedResultRefs: string[];
}

export type ClassificationResult = 
  | { draft: DraftTask; classification: 'ready'; reasons: [] }
  | { draft: DraftTask; classification: 'needs_confirmation'; reasons: string[] }
  | { draft: DraftTask; classification: 'unrecoverable'; reasons: string[] };

export interface ClarificationEntry {
  draftId: string;
  taskIndex: number;
  proposedDraft: { prompt: string; filePaths?: string[]; done?: string };
  assumptions: string[];
  questions: string[];
  reason: string;
}

export interface HardError {
  draftId: string;
  taskIndex: number;
  error: string;
  errorCode: string;
}

export interface IntakeProgress {
  totalDrafts: number;
  readyDrafts: number;
  clarificationDrafts: number;
  hardErrorDrafts: number;
  executedDrafts: number;
}

export interface ReadyDraft {
  task: TaskSpec;
  draftId: string;
  taskIndex: number;
}

export interface IntakeResult {
  ready: ReadyDraft[];
  clarifications: ClarificationEntry[];
  hardErrors: HardError[];
  intakeProgress: IntakeProgress;
}
