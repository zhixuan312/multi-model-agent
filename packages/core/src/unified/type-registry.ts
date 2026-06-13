import type { AgentType } from '../types/task-spec.js';

export const TASK_TYPES = [
  'audit', 'investigate', 'delegate', 'execute_plan',
  'review', 'debug', 'research', 'journal_recall', 'journal_record',
  'retry_tasks', 'main',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];
export type SandboxPolicy = 'read-only' | 'cwd-only';

export interface TypeConfig {
  defaultTier: AgentType;
  worktree: boolean;
  sandbox: SandboxPolicy;
}

export const TYPE_REGISTRY: Record<TaskType, TypeConfig> = {
  audit:          { defaultTier: 'complex',  worktree: false, sandbox: 'read-only' },
  investigate:    { defaultTier: 'complex',  worktree: false, sandbox: 'read-only' },
  delegate:       { defaultTier: 'standard', worktree: true,  sandbox: 'cwd-only'  },
  execute_plan:   { defaultTier: 'standard', worktree: true,  sandbox: 'cwd-only'  },
  review:         { defaultTier: 'complex',  worktree: false, sandbox: 'read-only' },
  debug:          { defaultTier: 'complex',  worktree: false, sandbox: 'read-only' },
  research:       { defaultTier: 'complex',  worktree: false, sandbox: 'read-only' },
  journal_recall: { defaultTier: 'complex',  worktree: false, sandbox: 'read-only' },
  journal_record: { defaultTier: 'complex',  worktree: false, sandbox: 'cwd-only'  },
  retry_tasks:    { defaultTier: 'standard', worktree: false, sandbox: 'cwd-only'  },
  main:           { defaultTier: 'main',     worktree: false, sandbox: 'read-only' },
};

export function getTypeConfig(type: TaskType): TypeConfig {
  const cfg = TYPE_REGISTRY[type];
  if (!cfg) throw new Error(`Unknown task type: ${type}`);
  return cfg;
}

export function oppositeAgent(tier: AgentType): AgentType {
  if (tier === 'main') return 'complex';
  return tier === 'standard' ? 'complex' : 'standard';
}
