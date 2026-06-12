// Shared Goal assembler. Each write route's briefSlot derives its task list +
// tiers + reviewPolicy and calls assembleGoal, which renders the planText and
// fills the Goal. This is the single construction point — adding a write route
// means a new briefSlot calling this, nothing else.
import { randomUUID } from 'node:crypto';
import type { Goal, GoalTask, GoalPhase, GoalSource, GoalReviewPolicy } from '../types/goal.js';
import type { ToolMode, SandboxPolicy } from '../types/task-spec.js';
import { renderPlanText, derivePhaseTimeoutMs, GOAL_IDLE_STALL_MS } from './goal-prompts.js';

export interface TaskInput {
  heading: string;
  body: string;
  /** 1-based plan-phase; defaults to 1 (single checkpoint). */
  phase?: number;
}

export interface AssembleGoalArgs {
  source: GoalSource;
  cwd: string;
  tasks: TaskInput[];
  /** Phase tiers. [implement] or [implement, review-fix]. */
  phases: GoalPhase[];
  reviewPolicy: GoalReviewPolicy;
  tools: ToolMode;
  sandboxPolicy: SandboxPolicy;
  skills?: string[];
  contextBlockIds?: string[];
  goalId?: string;
  /** Route-specific procedure prepended to both phase prompts. */
  preamble?: string;
  /** Operator's per-task wall-clock budget (config.defaults.timeoutMs); the phase
   *  deadline scales off it. Falls back to PER_TASK_DEFAULT_MS when unset. */
  perTaskTimeoutMs?: number;
}

export function assembleGoal(args: AssembleGoalArgs): Goal {
  const goalTasks: GoalTask[] = args.tasks.map((t, i) => ({
    n: i + 1,
    heading: t.heading.trim() || `task ${i + 1}`,
    body: t.body,
    phase: t.phase ?? 1,
  }));
  const phaseCount = new Set(goalTasks.map((t) => t.phase)).size;
  // reviewPolicy='none' collapses to phase-1 only (configured phase-1 tier).
  const phases = args.reviewPolicy === 'none' ? [args.phases[0]!] : args.phases;
  return {
    goalId: args.goalId ?? randomUUID(),
    cwd: args.cwd,
    source: args.source,
    tasks: goalTasks,
    phaseCount,
    planText: renderPlanText(goalTasks, phaseCount),
    ...(args.preamble && { preamble: args.preamble }),
    phases,
    reviewPolicy: args.reviewPolicy,
    sandboxPolicy: args.sandboxPolicy,
    tools: args.tools,
    ...(args.skills && args.skills.length > 0 && { skills: args.skills }),
    ...(args.contextBlockIds && args.contextBlockIds.length > 0 && { contextBlockIds: args.contextBlockIds }),
    goalPhaseTimeoutMs: derivePhaseTimeoutMs(goalTasks.length, args.perTaskTimeoutMs),
    goalIdleStallMs: GOAL_IDLE_STALL_MS,
  };
}

/**
 * Map a goal into the single TaskSpec the executor dispatches. The implement
 * prompt is materialized into `prompt`; phase-1 tier becomes `agentType`;
 * `reviewPolicy` collapses to the lifecycle's none/full axis (the review-fix
 * stage only distinguishes none vs run).
 */
export function goalToTaskSpec(
  goal: Goal,
  implementPrompt: string,
  timeoutMs: number,
): import('../types.js').TaskSpec {
  return {
    prompt: implementPrompt,
    goal,
    agentType: goal.phases[0]!.tier,
    reviewPolicy: goal.reviewPolicy === 'none' ? 'none' : 'full',
    cwd: goal.cwd,
    tools: goal.tools,
    sandboxPolicy: goal.sandboxPolicy,
    timeoutMs: goal.goalPhaseTimeoutMs ?? timeoutMs,
    ...(goal.goalIdleStallMs !== undefined && { idleStallMs: goal.goalIdleStallMs }),
    ...(goal.skills && { skills: goal.skills }),
    ...(goal.contextBlockIds && { contextBlockIds: goal.contextBlockIds }),
  };
}
