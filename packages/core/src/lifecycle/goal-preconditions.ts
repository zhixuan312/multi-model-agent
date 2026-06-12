// Hard-fail preconditions for a write goal-set, plus baseSha capture. ALL of
// this runs INSIDE withWriteGoalLock so the clean-tree-at-baseSha guarantee
// holds against other serialized goal-sets on the same repo.
import { isInsideWorkTree, currentHead, isCleanWorkTree, ensureGitIdentity } from './git-exec.js';
import { MAX_PLAN_TEXT_BYTES } from './goal-prompts.js';
import type { Goal } from '../types/goal.js';

export type GoalPreconditionCode =
  | 'empty_plan'
  | 'plan_too_large'
  | 'not_a_git_repo'
  | 'dirty_working_tree';

export type GoalPreconditionResult =
  | { ok: true; baseSha: string }
  | { ok: false; code: GoalPreconditionCode; message: string };

/** Synchronous build-time guards (no git): empty plan, oversized plan. */
export function checkGoalShape(goal: Goal): { ok: true } | { ok: false; code: GoalPreconditionCode; message: string } {
  if (!goal.tasks || goal.tasks.length === 0) {
    return { ok: false, code: 'empty_plan', message: 'goal has no tasks' };
  }
  const bytes = Buffer.byteLength(goal.planText, 'utf8');
  if (bytes > MAX_PLAN_TEXT_BYTES) {
    return { ok: false, code: 'plan_too_large', message: `planText ${bytes}B exceeds ${MAX_PLAN_TEXT_BYTES}B` };
  }
  return { ok: true };
}

/** Git preconditions + baseSha capture. Run inside withWriteGoalLock. */
export async function checkGitPreconditions(goal: Goal): Promise<GoalPreconditionResult> {
  const cwd = goal.cwd;
  if (!(await isInsideWorkTree(cwd))) {
    return { ok: false, code: 'not_a_git_repo', message: `${cwd} is not inside a git work-tree` };
  }
  const head = await currentHead(cwd);
  if (!head) {
    return { ok: false, code: 'not_a_git_repo', message: `${cwd} has no resolvable HEAD (unborn branch)` };
  }
  if (!(await isCleanWorkTree(cwd))) {
    return { ok: false, code: 'dirty_working_tree', message: `${cwd} has uncommitted changes; goal mode requires a clean tree` };
  }
  await ensureGitIdentity(cwd, goal.goalId);
  return { ok: true, baseSha: head };
}
