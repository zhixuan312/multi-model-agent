export type ToolMode = 'none' | 'readonly' | 'no-shell' | 'full';
export type AgentType = 'standard' | 'complex' | 'main';
export type Effort = 'none' | 'low' | 'medium' | 'high';
export type CostTier = 'free' | 'low' | 'medium' | 'high';
export type WorkerStatus = 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'review_loop_capped' | 'failed';

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
  mainModel?: string
  skills?: string[]
  subtype?: string
}
