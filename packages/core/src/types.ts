import type {
  AttemptRecord,
  RunOptions,
  RunStatus,
  TerminationReason,
  TokenUsage,
} from './runners/types.js';
import type { BriefQualityPolicy, BriefQualityWarning } from './intake/types.js';
import type { VerifyStageResult, VerifyStepStatus } from './run-tasks/verify-stage.js';
import { findModelProfile } from './routing/model-profiles.js';

export type ToolMode = 'none' | 'readonly' | 'no-shell' | 'full';
export type SandboxPolicy = 'none' | 'cwd-only';
export type AgentType = 'standard' | 'complex';
export type AgentCapability = 'web_search' | 'web_fetch';
export type Effort = 'none' | 'low' | 'medium' | 'high';
export type CostTier = 'free' | 'low' | 'medium' | 'high';

export interface AgentConfig {
  type: 'openai-compatible' | 'claude' | 'codex'
  model: string
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
  capabilities?: AgentCapability[]
  inputCostPerMTok?: number
  outputCostPerMTok?: number
  timeoutMs?: number
  sandboxPolicy?: SandboxPolicy
  inputTokenSoftLimit?: number
}

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
  maxCostUSD?: number
  reviewPolicy?: 'full' | 'spec_only' | 'diff_only' | 'off'
  maxReviewRounds?: number
  briefQualityPolicy?: BriefQualityPolicy
  parentModel?: string
  formatConstraints?: FormatConstraints
  skipCompletionHeuristic?: boolean
  expectedCoverage?: { minSections?: number; sectionPattern?: string; requiredMarkers?: string[] }
  requiredCapabilities?: AgentCapability[]
  testCommand?: string
  verifyCommand?: string[]
  autoCommit?: boolean
  planContext?: string
}

export interface CodexProviderConfig { type: 'codex'; model: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[]; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export interface ClaudeProviderConfig { type: 'claude'; model: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[]; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export interface OpenAICompatibleProviderConfig { type: 'openai-compatible'; model: string; baseUrl: string; apiKey?: string; apiKeyEnv?: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; hostedTools?: 'web_search'[]; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export type ProviderConfig = CodexProviderConfig | ClaudeProviderConfig | OpenAICompatibleProviderConfig

export interface MultiModelConfig {
  agents: { standard: AgentConfig; complex: AgentConfig }
  defaults: { timeoutMs: number; maxCostUSD: number; tools: ToolMode; sandboxPolicy: SandboxPolicy; largeResponseThresholdChars?: number; parentModel?: string }
  diagnostics?: { log: boolean; logDir?: string; verbose?: boolean }
  clarifications?: { maxRoundsPerDraft?: number }
  server: {
    bind: string
    port: number
    auth: { tokenFile: string }
    limits: { maxBodyBytes: number; batchTtlMs: number; idleProjectTimeoutMs: number; clarificationTimeoutMs: number; projectCap: number; maxBatchCacheSize: number; maxContextBlockBytes: number; maxContextBlocksPerProject: number; shutdownDrainMs: number }
    autoUpdateSkills: boolean
  }
}

export interface Commit {
  sha: string
  subject: string
  body: string
  filesChanged: string[]
  authoredAt: string
}

export interface RunResult {
  output: string
  status: RunStatus
  usage: TokenUsage
  turns: number
  filesRead: string[]
  filesWritten: string[]
  toolCalls: string[]
  outputIsDiagnostic: boolean
  escalationLog: AttemptRecord[]
  durationMs?: number
  directoriesListed?: string[]
  error?: string
  errorCode?: string
  retryable?: boolean
  briefQualityWarnings?: BriefQualityWarning[]
  terminationReason?: TerminationReason | 'round_cap' | 'cost_ceiling'
  reviewRounds?: { spec: number; quality: number; metadata: number; cap: number }
  concerns?: Array<{ source: 'spec_review' | 'quality_review' | 'diff_review' | 'verification' | 'diff_truncated'; severity: 'low' | 'medium' | 'high'; message: string }>
  structuredError?: { code: 'verify_command_error' | 'commit_metadata_invalid' | 'commit_metadata_repair_modified_files' | 'dirty_worktree' | 'diff_review_rejected' | 'runner_crash'; message: string; step?: number; status?: VerifyStepStatus; attemptsUsed?: number; dirtyTreePreserved?: boolean }
  workerStatus?: 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'review_loop_aborted' | 'failed'
  specReviewStatus?: 'approved' | 'changes_required' | 'skipped' | 'error' | 'not_applicable'
  specReviewReason?: string
  filePathsSkipped?: boolean
  fileArtifactsMissing?: boolean
  commits?: Commit[]
  commitError?: string
  capExhausted?: 'turn' | 'cost' | 'wall_clock'
  lifecycleClarificationRequested?: boolean
  workerError?: Error
  // 3.3.0 (T3): always populated by reviewed-lifecycle's verify stage when an
  // artifact-producing task runs through that path. Optional in the type so that
  // non-artifact paths and direct provider calls compile without per-site defaults.
  // The spec says "always present" — that invariant holds at the lifecycle boundary;
  // here the type is permissive to keep migration mechanical.
  verification?: VerifyStageResult
  qualityReviewStatus?: 'approved' | 'changes_required' | 'skipped' | 'error' | 'not_applicable'
  qualityReviewReason?: string
  structuredReport?: import('./reporting/structured-report.js').ParsedStructuredReport
  agents?: { implementer: 'standard' | 'complex' | 'not_run'; specReviewer: 'standard' | 'complex' | 'skipped' | 'not_applicable'; qualityReviewer: 'standard' | 'complex' | 'skipped' | 'not_applicable' }
  models?: { implementer: string; specReviewer: string | null; qualityReviewer: string | null }
  implementationReport?: import('./reporting/structured-report.js').ParsedStructuredReport
  specReviewReport?: import('./reporting/structured-report.js').ParsedStructuredReport
  qualityReviewReport?: import('./reporting/structured-report.js').ParsedStructuredReport
}

export interface Provider { name: string; config: ProviderConfig; run(prompt: string, options?: RunOptions): Promise<RunResult> }

export function computeCostUSD(inputTokens: number, outputTokens: number, config: ProviderConfig): number | null {
  const explicitRates = resolveRatePair(config.inputCostPerMTok, config.outputCostPerMTok);
  if (explicitRates !== null) return (inputTokens * explicitRates.input + outputTokens * explicitRates.output) / 1_000_000;
  const profile = findModelProfile(config.model);
  const profileRates = resolveRatePair(profile.inputCostPerMTok, profile.outputCostPerMTok);
  if (profileRates === null) return null;
  return (inputTokens * profileRates.input + outputTokens * profileRates.output) / 1_000_000;
}

export function computeSavedCostUSD(actualCostUSD: number | null, inputTokens: number, outputTokens: number, parentModel: string | undefined): number | null {
  if (actualCostUSD === null || parentModel === undefined) return null;
  const profile = findModelProfile(parentModel);
  const profileRates = resolveRatePair(profile.inputCostPerMTok, profile.outputCostPerMTok);
  if (profileRates === null) return null;
  return (inputTokens * profileRates.input + outputTokens * profileRates.output) / 1_000_000 - actualCostUSD;
}

function resolveRatePair(inputCostPerMTok: number | undefined, outputCostPerMTok: number | undefined): { input: number; output: number } | null {
  if (inputCostPerMTok !== undefined && outputCostPerMTok !== undefined && Number.isFinite(inputCostPerMTok) && Number.isFinite(outputCostPerMTok) && inputCostPerMTok >= 0 && outputCostPerMTok >= 0) return { input: inputCostPerMTok, output: outputCostPerMTok };
  return null;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T, abort?: AbortController): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => { abort?.abort(); resolve(onTimeout()); }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}
