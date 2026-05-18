// Per-task brief shape — what callers send to /delegate, /audit, etc.
// Matches spec architecture.md `types/task-spec.ts` slot.
import type { BriefQualityPolicy } from './brief-quality-policy.js';
import type { ResearchToolDefinition } from '../research/types.js';

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
   * Optional task-specific tool injection. When present, runner adapters
   * merge these tools into the worker's tool surface ON TOP of whatever
   * `tools: ToolMode` would normally produce. Used by `/research` (and the
   * `mma-explore` skill that orchestrates it) for the external researcher
   * worker only; all other executors leave this undefined. Runners MUST
   * treat `undefined` as a no-op.
   */
  customToolset?: ResearchToolDefinition[]
  /**
   * For read-only routes that go through the parallel-criteria dispatcher,
   * this is the user's pure question / work / problem text (route-specific
   * shape). Used as the "target" content embedded in the cached prefix so
   * sub-workers see ONLY the user's request — not the legacy monolithic
   * format spec that lives in `prompt`. When absent, the dispatcher falls
   * back to `document` then `prompt`. Audit: the inlined document. Review:
   * the code snippet + filePaths. Verify: work + checklist. Debug: problem
   * statement. Investigate: question.
   */
  parallelTarget?: string
  /**
   * v4.4.x: subtype field for read-only tools. Set by each tool's
   * buildTaskSpec from the input schema's `subtype` field. The lifecycle's
   * parallel-criteria dispatcher reads this to look up the per-tool
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
}
