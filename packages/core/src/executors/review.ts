// packages/core/src/executors/review.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../tool-schemas/review.js';
import type { TaskSpec } from '../types.js';
import { runTasks } from '../run-tasks.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { notApplicable } from '../reporting/not-applicable.js';
import { composeTerminalHeadline } from '../reporting/compose-terminal-headline.js';

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

function autoRegisterContextBlock(
  results: import('../types.js').RunResult[],
  store: import('../context/context-block-store.js').ContextBlockStore | undefined,
): string | undefined {
  if (!store) return undefined;
  const usable = results.filter(r => !r.outputIsDiagnostic && r.output.trim().length > 0);
  if (usable.length === 0) return undefined;
  const combined = usable.map(r => r.output).join('\n\n---\n\n');
  const { id } = store.register(combined);
  return id;
}

export interface ReviewOutput extends ExecutorOutput {
  contextBlockId?: string;
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
    reviewPolicy: 'full',
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
  const runtime = contextBlockStore ? { contextBlockStore } : undefined;

  const mode = resolveDispatchMode(input.code, input.filePaths);

  if (mode === 'fan_out') {
    const validPaths = input.filePaths!.filter(p => p.trim().length > 0);
    const promptTemplate = buildReviewPrompt(undefined, undefined, input.focus, hasContextBlocks);
    const tasks: TaskSpec[] = validPaths.map(fp => ({
      ...baseTaskSpec,
      prompt: buildPerFilePrompt(fp, promptTemplate),
    } as TaskSpec));

    const startMs = Date.now();
    const results = await runTasks(tasks, config, { runtime });
    const wallClockMs = Date.now() - startMs;
    const ctxId = autoRegisterContextBlock(results, contextBlockStore);
    const batchTimings = computeTimings(wallClockMs, results);
    const costSummary = computeAggregateCost(results);

    return {
      headline: composeTerminalHeadline({ tool: 'review', awaitingClarification: false, tasksTotal: tasks.length, tasksCompleted: results.length }),
      results,
      batchTimings,
      costSummary,
      structuredReport: notApplicable('no structured report emitted by this executor'),
      error: notApplicable('batch succeeded'),
      proposedInterpretation: notApplicable('batch not awaiting clarification'),
      batchId: randomUUID(),
      wallClockMs,
      parentModel,
      ...(ctxId !== undefined && { contextBlockId: ctxId }),
    };
  }

  const prompt = buildReviewPrompt(input.code, input.filePaths, input.focus, hasContextBlocks);
  const results = await runTasks([{ ...baseTaskSpec, prompt } as TaskSpec], config, { runtime });
  const ctxId = autoRegisterContextBlock(results, contextBlockStore);
  const batchTimings = computeTimings(0, results);
  const costSummary = computeAggregateCost(results);

  return {
    headline: composeTerminalHeadline({ tool: 'review', awaitingClarification: false, tasksTotal: 1, tasksCompleted: results.length }),
    results,
    batchTimings,
    costSummary,
    structuredReport: notApplicable('no structured report emitted by this executor'),
    error: notApplicable('batch succeeded'),
    proposedInterpretation: notApplicable('batch not awaiting clarification'),
    batchId: randomUUID(),
    wallClockMs: 0,
    parentModel,
    ...(ctxId !== undefined && { contextBlockId: ctxId }),
  };
}
