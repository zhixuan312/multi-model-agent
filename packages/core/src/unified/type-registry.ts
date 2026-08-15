import type { AgentType } from '../types/task-spec.js';

export const TASK_TYPES = [
  'audit', 'investigate', 'delegate', 'execute_plan',
  'review', 'debug', 'research', 'journal_recall', 'journal_record',
  'orchestrate', 'spec', 'plan',
] as const;

import type { SandboxPolicy } from '../types/enums.js';

export type TaskType = (typeof TASK_TYPES)[number];
export type { SandboxPolicy } from '../types/enums.js';

export interface TargetAcceptance {
  paths: boolean;
  inline: boolean;
  required: boolean;
}

export interface TypeConfig {
  defaultTier: AgentType;
  readerFacing: boolean;
  /** Write routes: the engine captures a git baseline and commits on the caller's branch.
   *  It never creates a branch or a worktree — the caller owns those. */
  writeRoute: boolean;
  sandbox: SandboxPolicy;
  targetAcceptance: TargetAcceptance;
}

export const TYPE_REGISTRY: Record<TaskType, TypeConfig> = {
  audit:          { defaultTier: 'complex',  writeRoute: false, sandbox: 'read-only',  readerFacing: true,  targetAcceptance: { paths: true,  inline: true,  required: true  } },
  investigate:    { defaultTier: 'complex',  writeRoute: false, sandbox: 'read-only',  readerFacing: true,  targetAcceptance: { paths: true,  inline: false, required: false } },
  delegate:       { defaultTier: 'standard', writeRoute: true, sandbox: 'cwd-only',  readerFacing: false, targetAcceptance: { paths: true,  inline: false, required: false } },
  execute_plan:   { defaultTier: 'standard', writeRoute: true, sandbox: 'cwd-only',  readerFacing: false, targetAcceptance: { paths: true,  inline: false, required: true  } },
  review:         { defaultTier: 'complex',  writeRoute: false, sandbox: 'read-only',  readerFacing: true,  targetAcceptance: { paths: true,  inline: true,  required: true  } },
  debug:          { defaultTier: 'complex',  writeRoute: false, sandbox: 'read-only',  readerFacing: true,  targetAcceptance: { paths: true,  inline: false, required: false } },
  research:       { defaultTier: 'complex',  writeRoute: false, sandbox: 'read-only', readerFacing: true,  targetAcceptance: { paths: false, inline: false, required: false } },
  journal_recall: { defaultTier: 'complex',  writeRoute: false, sandbox: 'read-only', readerFacing: true,  targetAcceptance: { paths: false, inline: false, required: false } },
  journal_record: { defaultTier: 'complex',  writeRoute: false, sandbox: 'cwd-only', readerFacing: true,  targetAcceptance: { paths: false, inline: false, required: false } },
  orchestrate:    { defaultTier: 'main',     writeRoute: false, sandbox: 'cwd-only', readerFacing: false, targetAcceptance: { paths: false, inline: false, required: false } },
  spec:           { defaultTier: 'complex',  writeRoute: false, sandbox: 'cwd-only',  readerFacing: true,  targetAcceptance: { paths: true,  inline: true,  required: true  } },
  plan:           { defaultTier: 'complex',  writeRoute: false, sandbox: 'cwd-only',  readerFacing: true,  targetAcceptance: { paths: true,  inline: true,  required: true  } },
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
