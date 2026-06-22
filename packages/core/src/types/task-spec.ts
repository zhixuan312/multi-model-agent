import type { BriefQualityPolicy } from './brief-quality-policy.js';

export type ToolMode = 'none' | 'readonly' | 'no-shell' | 'full';
export type AgentType = 'standard' | 'complex' | 'main';
export type Effort = 'none' | 'low' | 'medium' | 'high';
export type CostTier = 'free' | 'low' | 'medium' | 'high';
export type WorkerStatus = 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'review_loop_capped' | 'failed';

export interface FormatConstraints {
  inputFormat?: 'json' | 'yaml' | 'xml' | 'csv' | 'markdown';
  outputFormat?: 'json' | 'yaml' | 'xml' | 'csv' | 'markdown';
}

export interface TaskSpec {
  prompt: string
  agentType?: AgentType
  done?: string
  contextBlockIds?: string[]
  tools?: ToolMode
  timeoutMs?: number
  cwd?: string
  effort?: Effort
  reviewPolicy?: 'reviewed' | 'none'
  briefQualityPolicy?: BriefQualityPolicy
  mainModel?: string
  formatConstraints?: FormatConstraints
  skipCompletionHeuristic?: boolean
  expectedCoverage?: { minSections?: number; sectionPattern?: string; requiredMarkers?: string[] }
  testCommand?: string
  planContext?: string
  outputTargets?: string[]
  skills?: string[]
  subtype?: string
  idleStallMs?: number
}
