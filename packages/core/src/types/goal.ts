// The write-path primitive. A Goal is built once per write-route request
// (delegate / execute-plan / retry / journal-record) by that route's buildGoal,
// then run as a two-phase goal-set: one autonomous implement send over the whole
// plan, then (unless reviewPolicy='none') one autonomous review-fix send. The
// agent self-commits per task; git is the inter-phase handoff and the report
// source. See docs/superpowers/specs/2026-06-09-goal-mode-write-routes-design.md.
import type { AgentType, ToolMode, SandboxPolicy } from './task-spec.js';

export type GoalSource = 'delegate' | 'execute-plan' | 'journal-record';
export type GoalPhaseMode = 'implement' | 'review-fix';
export type GoalReviewPolicy = 'review-fix' | 'none';

export interface GoalPhase {
  /** Provider tier this phase runs on. Route-configurable, not a constant. */
  tier: AgentType;
  mode: GoalPhaseMode;
}

export interface GoalTask {
  /** 1-based task number, used in the `[task N]` commit convention. */
  n: number;
  /** Short heading — derived per route; used in the commit subject + report. */
  heading: string;
  /** The task's full instruction body (plan section / prompt / learning). */
  body: string;
  /** 1-based plan-phase index this task belongs to (for `PHASE k` checkpoints). */
  phase: number;
}

export interface Goal {
  goalId: string;
  cwd: string;
  source: GoalSource;
  /** Ordered, ≥1. Empty input is rejected upstream (`empty_plan`). */
  tasks: GoalTask[];
  /** Number of plan-phase boundaries (distinct `GoalTask.phase` values). */
  phaseCount: number;
  /** The whole plan rendered as one prompt body, with `PHASE k:` + `[task N]` markers. */
  planText: string;
  /** Optional route-specific procedure prepended to both phase prompts (e.g. the
   *  journal integration procedure). Undefined for delegate/execute-plan. */
  preamble?: string;
  /** [implement] or [implement, review-fix]; tiers are route-configured. */
  phases: GoalPhase[];
  reviewPolicy: GoalReviewPolicy;
  sandboxPolicy: SandboxPolicy;
  tools: ToolMode;
  skills?: string[];
  contextBlockIds?: string[];
  /** Per-phase wall-clock override; default derived from task count. */
  goalPhaseTimeoutMs?: number;
  /** Idle-stall threshold for goal-mode sends; default max(perTaskIdle, 10m). */
  goalIdleStallMs?: number;
  /** Honored as a contract budget when present; otherwise uncapped (meter only). */
  maxCostUSD?: number;
}
