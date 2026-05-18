import type { AgentType } from '../types.js';

// Source-route union: the routes through which a draft can be constructed.
// Each variant carries its route-specific fields alongside the original input.
export type SourceRoute = 'delegate_tasks' | 'review_code' | 'debug_task' | 'verify_work' | 'audit_document' | 'execute_plan' | 'investigate_codebase';

export type DelegateSource = { route: 'delegate_tasks'; originalInput: Record<string, unknown> };
export type ReviewSource = { route: 'review_code'; originalInput: Record<string, unknown>; code?: string; inlineContent?: string; focus?: string[] };
export type DebugSource = { route: 'debug_task'; originalInput: Record<string, unknown>; problem: string; context?: string; hypothesis?: string };
export type VerifySource = { route: 'verify_work'; originalInput: Record<string, unknown>; checklist: string[]; work?: string };
export type AuditSource = { route: 'audit_document'; originalInput: Record<string, unknown>; document?: string; subtype?: string };
export type ExecutePlanSource = { route: 'execute_plan'; originalInput: Record<string, unknown>; filePaths: string[]; task: string };
export type InvestigateSource = { route: 'investigate_codebase'; originalInput: Record<string, unknown>; question: string; filePaths: string[] };
export type AnySource = DelegateSource | ReviewSource | DebugSource | VerifySource | AuditSource | ExecutePlanSource | InvestigateSource;

export interface DraftTask {
  draftId: string;
  source: AnySource;
  prompt: string;
  done?: string;
  filePaths?: string[];
  agentType?: AgentType;
  assumptions?: string[];
  questions?: string[];
  confirmed?: boolean;
  contextBlockIds?: string[];
  reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none';
  skipCompletionHeuristic?: boolean;
}
