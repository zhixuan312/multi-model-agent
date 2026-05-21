// Per-task brief shape — what callers send to /delegate, /audit, etc.
// Matches spec architecture.md `types/task-spec.ts` slot.
import type { BriefQualityPolicy } from './brief-quality-policy.js';

export type ToolMode = 'none' | 'readonly' | 'no-shell' | 'full';
export type SandboxPolicy = 'none' | 'cwd-only';
export type AgentType = 'standard' | 'complex';
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
  reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none'
  briefQualityPolicy?: BriefQualityPolicy
  mainModel?: string
  formatConstraints?: FormatConstraints
  skipCompletionHeuristic?: boolean
  expectedCoverage?: { minSections?: number; sectionPattern?: string; requiredMarkers?: string[] }
  testCommand?: string
  autoCommit?: boolean
  planContext?: string
  outputTargets?: string[]
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
  /**
   * v4.4.x: subtype field for read-only tools. Set by each tool's
   * buildTaskSpec from the input schema's `subtype` field. The lifecycle's
   * read-route dispatcher reads this to look up the per-tool
   * SUBTYPES map and select the matching criteria / orientation /
   * semantics block. Defaults to 'default' when undefined.
   *
   * Per-tool enums today:
   *   audit:       'default' | 'plan' | 'spec' | 'skill'
   *   review:      'default'
   *   debug:       'default'
   *   investigate: 'default'
   *   research:    'default'
   */
  subtype?: string
  /**
   * Research-specific metadata passed from the /research dispatcher to perform-implementation.
   * Contains question, background, user sources, and resolved context blocks needed by the
   * two-turn driver before the N-criterion synthesis loop begins. Only set for /research route.
   */
  research?: {
    researchQuestion: string;
    background?: string;
    userSources?: string[];
    resolvedContextBlocks?: Array<{ id: string; content: string }>;
  }
}
