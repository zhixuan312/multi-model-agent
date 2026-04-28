// packages/core/src/executors/review.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../tool-schemas/review.js';
import type { TaskSpec, RunResult } from '../types.js';
import { resolveAgent } from '../routing/resolve-agent.js';
import { executeReviewedLifecycle } from '../run-tasks/reviewed-lifecycle.js';
import { buildReviewQualityPrompt } from '../review/quality-only-prompts.js';
import { mapReviewVerdicts } from './_shared/review-verdict-mapping.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { notApplicable } from '../reporting/not-applicable.js';
import { composeTerminalHeadline } from '../reporting/compose-terminal-headline.js';
import { expandContextBlocks } from '../context/expand-context-blocks.js';

// --- Ported from packages/mcp/src/tools/review-code.ts ---

const REVIEW_DONE_CONDITIONS: Record<string, string> = {
  security: 'Identify security vulnerabilities with severity, location, and remediation.',
  performance: 'Identify performance issues with impact level, location, and fix recommendation.',
  correctness: 'Identify logic errors, edge cases, and contract violations with severity and location.',
  style: 'Identify style issues, naming inconsistencies, and dead code with location and fix.',
};

const DELTA_REVIEW_SUFFIX = ' Perform a full review (do not reduce thoroughness). Verify each prior finding as addressed or unaddressed. Omit addressed prior findings. Include unaddressed prior findings and new findings. End with a summary of which prior findings were resolved.';

function resolveReviewDoneCondition(focus: string[] | undefined, hasContextBlocks: boolean): string {
  let base: string;
  if (!focus || focus.length === 0) {
    base = 'Review code for correctness, security, performance, and style. Each finding has category, severity, location, and recommendation.';
  } else {
    base = focus.map(f => REVIEW_DONE_CONDITIONS[f] ?? '').filter(Boolean).join(' ');
  }
  return hasContextBlocks ? base + DELTA_REVIEW_SUFFIX : base;
}

function buildFilePathsPrompt(filePaths?: string[]): string {
  if (!filePaths || filePaths.length === 0) return '';
  return `Read and analyze these files:\n${filePaths.map(p => `- ${p}`).join('\n')}`;
}

function buildPerFilePrompt(filePath: string, promptTemplate: string): string {
  return `${promptTemplate}\n\nRead and analyze this file:\n- ${filePath}`;
}

function buildReviewPrompt(
  code: string | undefined,
  filePaths: string[] | undefined,
  focus: string[] | undefined,
  hasContextBlocks: boolean,
): string {
  const parts: string[] = ['Review this code:'];
  if (code) parts.push(`\`\`\`\n${code}\n\`\`\``);
  const fileSection = buildFilePathsPrompt(filePaths);
  if (fileSection) parts.push(fileSection);
  if (focus && focus.length > 0) parts.push(`Focus areas: ${focus.join(', ')}.`);
  if (hasContextBlocks) {
    parts.push(
      'Context is provided above (e.g. a diff or prior review). Perform a full review as normal — do not skip areas or reduce thoroughness.',
      'If the context contains prior review findings:',
      '- **Omit** findings that have been addressed — do not re-report them.',
      '- **Include** findings that are still present (mark as "unfixed from prior review").',
      '- **Include** any new findings.',
      '- End with a **Fixed** summary listing which prior findings were resolved.',
    );
  } else {
    parts.push('Provide a structured review with findings and recommendations.');
  }
  return parts.join('\n\n');
}

function hasContent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function resolveDispatchMode(
  inlineContent: string | undefined,
  filePaths: string[] | undefined,
): 'single' | 'fan_out' {
  if (hasContent(inlineContent)) return 'single';
  const validPaths = (filePaths ?? []).filter(p => p.trim().length > 0);
  if (validPaths.length >= 2) return 'fan_out';
  return 'single';
}

export interface ReviewOutput extends ExecutorOutput {
  contextBlockId?: string;
}

async function runSingleReview(
  task: TaskSpec,
  agentType: 'standard' | 'complex',
  config: ExecutionContext['config'],
  ctx: ExecutionContext,
  taskIndex: number,
): Promise<RunResult> {
  const resolved = resolveAgent(agentType, [], config);
  return executeReviewedLifecycle(
    task,
    resolved,
    config,
    taskIndex,
    undefined,
    { batchId: ctx.batchId, recordHeartbeat: ctx.recordHeartbeat },
    { logger: ctx.logger },
    ctx.recorder,
    ctx.route ?? 'review',
    ctx.client,
    ctx.triggeringSkill,
    ctx.bus,
    buildReviewQualityPrompt,
  );
}

export async function executeReview(
  ctx: ExecutionContext,
  input: Input,
): Promise<ReviewOutput> {
  const { config, contextBlockStore } = ctx;

  const hasContextBlocks = Array.isArray(input.contextBlockIds) && input.contextBlockIds.length > 0;
  const parentModel = ctx.parentModel ?? config.defaults?.parentModel ?? undefined;

  const baseTaskSpec: Partial<TaskSpec> = {
    agentType: 'complex',
    reviewPolicy: 'quality_only',
    briefQualityPolicy: 'off',
    done: resolveReviewDoneCondition(input.focus, hasContextBlocks),
    tools: config.defaults?.tools ?? 'full',
    timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
    maxCostUSD: config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
    cwd: ctx.projectContext.cwd,
    contextBlockIds: input.contextBlockIds,
    parentModel,
  };

  const mode = resolveDispatchMode(input.code, input.filePaths);

  // Build the list of tasks (fan_out creates one per file path, single creates one)
  let taskSpecs: TaskSpec[];
  if (mode === 'fan_out') {
    const validPaths = input.filePaths!.filter(p => p.trim().length > 0);
    const promptTemplate = buildReviewPrompt(undefined, undefined, input.focus, hasContextBlocks);
    taskSpecs = validPaths.map(fp => ({
      ...baseTaskSpec,
      prompt: buildPerFilePrompt(fp, promptTemplate),
    } as TaskSpec));
  } else {
    const prompt = buildReviewPrompt(input.code, input.filePaths, input.focus, hasContextBlocks);
    taskSpecs = [{ ...baseTaskSpec, prompt } as TaskSpec];
  }

  // Expand context blocks for each task
  const expandedTasks: TaskSpec[] = taskSpecs.map(task => {
    try {
      return expandContextBlocks(task, contextBlockStore) as TaskSpec;
    } catch (e) {
      ctx.logger.error('expandContextBlocks_failed_review', e);
      return task;
    }
  });

  const startMs = Date.now();
  const results = await Promise.all(
    expandedTasks.map((task, i) =>
      runSingleReview(task, task.agentType ?? 'complex', config, ctx, i).catch((e): RunResult => {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          output: '', status: 'error' as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
          turns: 0, filesRead: [], filesWritten: [], toolCalls: [],
          outputIsDiagnostic: false, escalationLog: [],
          error: msg, errorCode: 'executor_error', retryable: false,
          durationMs: 0,
          structuredError: { code: 'executor_error' as const, message: msg, where: 'executor:review' },
          workerStatus: 'failed' as const,
        };
      }),
    ),
  );
  const wallClockMs = Date.now() - startMs;

  const batchTimings = computeTimings(wallClockMs, results);
  const costSummary = computeAggregateCost(results);

  // Surface review verdicts from the lifecycle
  const primaryResult = results[0];
  const verdicts = mapReviewVerdicts(primaryResult ?? {}, false);

  return {
    headline: composeTerminalHeadline({ tool: 'review', awaitingClarification: false, tasksTotal: taskSpecs.length, tasksCompleted: results.length }),
    results,
    batchTimings,
    costSummary,
    structuredReport: notApplicable('no structured report emitted by this executor'),
    error: notApplicable('batch succeeded'),
    proposedInterpretation: notApplicable('batch not awaiting clarification'),
    batchId: randomUUID(),
    wallClockMs,
    parentModel,
    specReviewVerdict: verdicts.specReviewVerdict,
    qualityReviewVerdict: verdicts.qualityReviewVerdict,
    roundsUsed: verdicts.roundsUsed,
  };
}
