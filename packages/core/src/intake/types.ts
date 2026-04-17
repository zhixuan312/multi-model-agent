import type { TaskSpec } from '../types.js';

export type SourceRoute = 'delegate_tasks' | 'review_code' | 'debug_task' | 'verify_work' | 'audit_document';

export type DelegateSource = { route: 'delegate_tasks'; originalInput: Record<string, unknown> };
export type ReviewSource = { route: 'review_code'; originalInput: Record<string, unknown>; code?: string; inlineContent?: string; focus?: string[] };
export type DebugSource = { route: 'debug_task'; originalInput: Record<string, unknown>; problem: string; context?: string; hypothesis?: string };
export type VerifySource = { route: 'verify_work'; originalInput: Record<string, unknown>; checklist: string[]; work?: string };
export type AuditSource = { route: 'audit_document'; originalInput: Record<string, unknown>; document?: string; auditType?: string };
export type AnySource = DelegateSource | ReviewSource | DebugSource | VerifySource | AuditSource;

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
