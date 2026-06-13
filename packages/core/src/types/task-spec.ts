// Per-task brief shape — what callers send to /delegate, /audit, etc.
// Matches spec architecture.md `types/task-spec.ts` slot.
import type { BriefQualityPolicy } from './brief-quality-policy.js';
import type { Goal } from './goal.js';

export type ToolMode = 'none' | 'readonly' | 'no-shell' | 'full';
export type SandboxPolicy = 'none' | 'cwd-only';
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
  filePaths?: string[]
  done?: string
  contextBlockIds?: string[]
  tools?: ToolMode
  timeoutMs?: number
  cwd?: string
  effort?: Effort
  sandboxPolicy?: SandboxPolicy
  reviewPolicy?: 'reviewed' | 'none'
  briefQualityPolicy?: BriefQualityPolicy
  mainModel?: string
  formatConstraints?: FormatConstraints
  skipCompletionHeuristic?: boolean
  expectedCoverage?: { minSections?: number; sectionPattern?: string; requiredMarkers?: string[] }
  testCommand?: string
  planContext?: string
  outputTargets?: string[]
  /** Skill names the worker should be equipped with (delegate route only).
   *  Resolved + staged before the session opens. */
  skills?: string[]
  /**
   * For read-only routes that go through the read-route dispatcher, this is
   * the user's pure question / work / problem text (route-specific shape),
   * set by each route's buildTaskSpec. Used as the "target" content embedded
   * in the cached prefix so sub-workers see ONLY the user's request — not a
   * legacy monolithic format spec. The dispatcher uses this then `document`;
   * there is NO `prompt` fallback (a non-research read route with an empty
   * target throws `read_route_missing_target`). Audit: the inlined document /
   * file targets. Review: the code snippet + filePaths. Debug: problem
   * statement. Investigate: question. Research: the research question (the
   * actual worker input is built from `research`).
   */
  readTarget?: string
  subtype?: string
  /**
   * Research-specific metadata passed from the /research dispatcher to perform-implementation.
   * Contains question, background, user sources, and resolved context blocks needed by the
   * two-turn driver before the N-criterion synthesis loop begins. Only set for /research route.
   */
  research?: {
    researchQuestion: string;
    background?: string;
    resolvedContextBlocks?: Array<{ id: string; content: string }>;
  }
  taskDescriptor?: string
  planBasename?: string
  /**
   * Write-route goal-set primitive. Set by each write route's buildGoal (via
   * the single-brief slot). When present, the task is a goal-set: the implement
   * stage sends the implement prompt (already materialized into `prompt`), and
   * the review-fix stage + annotate read `goal` for phase-2 tier, conventions,
   * and report rebuild. Absent on read routes.
   */
  goal?: Goal
  /** Per-task idle-stall override (goal mode widens this); falls back to config default. */
  idleStallMs?: number
}
