// live-smoke
import type { AgentType } from '../types/task-spec.js';

export const TASK_TYPES = [
  'audit', 'investigate', 'delegate', 'execute_plan',
  'review', 'debug', 'research', 'journal_recall', 'journal_record',
  'retry_tasks', 'orchestrate', 'spec', 'plan',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];
export type SandboxPolicy = 'read-only' | 'cwd-only';

export interface TargetAcceptance {
  paths: boolean;
  inline: boolean;
  required: boolean;
}

export interface TypeConfig {
  defaultTier: AgentType;
  worktree: boolean;
  sandbox: SandboxPolicy;
  targetAcceptance: TargetAcceptance;
}

export const TYPE_REGISTRY: Record<TaskType, TypeConfig> = {
  audit:          { defaultTier: 'complex',  worktree: false, sandbox: 'read-only', targetAcceptance: { paths: true,  inline: true,  required: true  } },
  investigate:    { defaultTier: 'complex',  worktree: false, sandbox: 'read-only', targetAcceptance: { paths: true,  inline: false, required: false } },
  delegate:       { defaultTier: 'standard', worktree: true,  sandbox: 'cwd-only',  targetAcceptance: { paths: true,  inline: false, required: false } },
  execute_plan:   { defaultTier: 'standard', worktree: true,  sandbox: 'cwd-only',  targetAcceptance: { paths: true,  inline: false, required: true  } },
  review:         { defaultTier: 'complex',  worktree: false, sandbox: 'read-only', targetAcceptance: { paths: true,  inline: true,  required: true  } },
  debug:          { defaultTier: 'complex',  worktree: false, sandbox: 'read-only', targetAcceptance: { paths: true,  inline: false, required: false } },
  research:       { defaultTier: 'complex',  worktree: false, sandbox: 'read-only', targetAcceptance: { paths: false, inline: false, required: false } },
  journal_recall: { defaultTier: 'complex',  worktree: false, sandbox: 'read-only', targetAcceptance: { paths: false, inline: false, required: false } },
  journal_record: { defaultTier: 'complex',  worktree: false, sandbox: 'cwd-only',  targetAcceptance: { paths: false, inline: false, required: false } },
  retry_tasks:    { defaultTier: 'standard', worktree: false, sandbox: 'cwd-only',  targetAcceptance: { paths: false, inline: false, required: false } },
  orchestrate:    { defaultTier: 'main',     worktree: false, sandbox: 'cwd-only',  targetAcceptance: { paths: false, inline: false, required: false } },
  spec:           { defaultTier: 'complex',  worktree: false, sandbox: 'cwd-only',  targetAcceptance: { paths: true,  inline: true,  required: true  } },
  plan:           { defaultTier: 'complex',  worktree: false, sandbox: 'cwd-only',  targetAcceptance: { paths: true,  inline: true,  required: true  } },
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
