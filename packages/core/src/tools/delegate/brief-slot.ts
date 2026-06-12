import type { Input } from './schema.js';
import type { GoalReviewPolicy } from '../../types/goal.js';
import type { AgentType } from '../../types.js';
import type { TaskInput } from '../../lifecycle/goal-builder.js';
import { firstLine } from '../../lifecycle/goal-prompts.js';
import {
  DELEGATE_SCOPE_RULE,
  DELEGATE_FAILURE_MODES,
} from './implementer-criteria.js';

/**
 * One goal-set per /delegate call. Each caller task becomes one GoalTask; the
 * whole list runs as a single autonomous implement pass (phase 1) then a
 * complex-tier review-fix pass (phase 2). The brief carries the derived task
 * list + tier + reviewPolicy; the Goal itself is assembled in buildTaskSpec
 * (which has the ExecutionContext for cwd/tools/sandbox).
 */
export interface DelegateBrief {
  tasks: TaskInput[];
  phase1Tier: AgentType;
  reviewPolicy: GoalReviewPolicy;
  skills?: string[];
  contextBlockIds?: string[];
}

/** Per-task body: the caller's contract + scope/file constraints + fidelity rules. */
function taskBody(t: Input['tasks'][number]): string {
  const parts: string[] = [t.prompt];
  if (t.done) parts.push('', `Acceptance criteria: ${t.done}`);
  if (t.filePaths && t.filePaths.length > 0) {
    parts.push('', `Write to exactly these path(s), no others, no renames: ${t.filePaths.map((p) => `\`${p}\``).join(', ')}. Non-existent paths are output targets — create them.`);
  }
  if (t.outputTargets && t.outputTargets.length > 0) {
    parts.push('', `This task MUST produce these output file(s): ${t.outputTargets.map((p) => `\`${p}\``).join(', ')}.`);
  }
  parts.push('', DELEGATE_SCOPE_RULE, '', DELEGATE_FAILURE_MODES);
  return parts.join('\n');
}

export const delegateBriefSlot = (input: Input): DelegateBrief[] => {
  const tasks: TaskInput[] = input.tasks.map((t) => ({
    heading: firstLine(t.prompt),
    body: taskBody(t),
    phase: 1,
  }));
  // Any complex task lifts the implement phase to complex; review-fix is always complex.
  const phase1Tier: AgentType = input.tasks.some((t) => t.agentType === 'complex') ? 'complex' : 'standard';
  // The goal reviews unless every task opted out of review.
  const reviewPolicy: GoalReviewPolicy = input.tasks.every((t) => t.reviewPolicy === 'none') ? 'none' : 'review-fix';
  const skills = [...new Set(input.tasks.flatMap((t) => t.skills ?? []))];
  const contextBlockIds = [...new Set(input.tasks.flatMap((t) => t.contextBlockIds ?? []))];
  return [{ tasks, phase1Tier, reviewPolicy, skills, contextBlockIds }];
};
