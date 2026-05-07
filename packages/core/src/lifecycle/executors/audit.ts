// packages/core/src/executors/audit.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { ExecutorOutput } from '../executor-output-types.js';
import type { Input } from '../../tools/audit/schema.js';
import type { TaskSpec, RunResult } from '../../types.js';
import { runTasks } from '../dispatch-task.js';
import { runTaskViaDispatcher } from '../dispatch-task.js';
import { resolveAgent } from '../../escalation/agent-resolver.js';
import { buildAuditQualityPrompt } from '../../review/quality-only-prompts.js';
import { mapReviewVerdicts } from '../../review/review-verdict-mapping.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { notApplicable } from '../../reporting/not-applicable.js';
import { composeTerminalHeadline } from '../../reporting/compose-terminal-headline.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';
import { createDefaultReviewerEngine, createDefaultAnnotatorEngine } from '../../review/default-engines.js';

// --- Ported from packages/mcp/src/tools/audit-document.ts ---

function resolveAuditTypeText(auditType: Input['auditType']): string {
  if (auditType === 'general') return 'security, performance, correctness, and style';
  if (Array.isArray(auditType)) return auditType.join(', ');
  return auditType;
}

const AUDIT_DONE_CONDITIONS: Record<string, string> = {
  security: 'Identify all security vulnerabilities (injection, auth bypass, data exposure, OWASP top 10). Each finding has severity (critical/high/medium/low), location, and remediation.',
  performance: 'Identify all performance issues (O(n²) loops, unnecessary allocations, missing caching, blocking I/O). Each finding has impact level, location, and fix recommendation.',
  correctness: 'Identify all logic errors, off-by-one bugs, unhandled edge cases, type mismatches, and contract violations. Each finding has severity, location, and correct behavior.',
  style: 'Identify all style issues (naming, formatting, dead code, inconsistent patterns). Each finding has location and recommended fix.',
  general: 'Identify issues across security, performance, correctness, and style. Each finding has category, severity, location, and remediation.',
};

const DELTA_AUDIT_SUFFIX = ' Perform a full audit (do not reduce thoroughness). Verify each prior finding as fixed or unfixed. Omit fixed prior findings from the main report. Include unfixed prior findings and new findings. End with a summary of which prior findings were resolved.';

function resolveAuditDoneCondition(auditType: Input['auditType'], hasContextBlocks: boolean): string {
  let base: string;
  if (auditType === 'general') {
    base = AUDIT_DONE_CONDITIONS.general;
  } else if (Array.isArray(auditType)) {
    base = auditType.map(t => AUDIT_DONE_CONDITIONS[t]).join(' ');
  } else {
    base = AUDIT_DONE_CONDITIONS[auditType] ?? AUDIT_DONE_CONDITIONS.general;
  }
  return hasContextBlocks ? base + DELTA_AUDIT_SUFFIX : base;
}

function buildFilePathsPrompt(filePaths?: string[]): string {
  if (!filePaths || filePaths.length === 0) return '';
  return `Read and analyze these files:\n${filePaths.map(p => `- ${p}`).join('\n')}`;
}

function buildPerFilePrompt(filePath: string, promptTemplate: string): string {
  return `${promptTemplate}\n\nRead and analyze this file:\n- ${filePath}`;
}

function buildAuditPrompt(
  auditTypeText: string,
  document: string | undefined,
  filePaths: string[] | undefined,
  hasContextBlocks: boolean,
): string {
  const parts: string[] = [`Audit for ${auditTypeText} issues.`];
  if (document) parts.push(`Document:\n\n${document}`);
  const fileSection = buildFilePathsPrompt(filePaths);
  if (fileSection) parts.push(fileSection);
  if (hasContextBlocks) {
    parts.push(
      'A prior audit report is provided as context above.',
      'First, verify which prior findings have been fixed. Then perform a full audit as normal — do not skip areas or reduce thoroughness.',
      'In your output:',
      '- **Omit** prior findings that have been fixed — do not re-report them.',
      '- **Include** prior findings that are still present (mark as "unfixed from prior audit").',
      '- **Include** any new findings not in the prior report.',
      '- End with a **Fixed** summary listing which prior findings were resolved.',
    );
  } else {
    parts.push(
      'Produce a narrative audit report. Use this EXACT per-finding format so the deterministic extractor can recover findings if the structured reviewer pass fails:',
      '',
      '## Finding 1: <one-line title>',
      '- Severity: critical | high | medium | low',
      '- Location: file:line (when applicable)',
      '- Issue: one-paragraph explanation',
      '- Suggestion: one-line fix recommendation',
      '',
      '## Finding 2: <one-line title>',
      '- Severity: ...',
      '- ...',
      '',
      'Rules:',
      '- Each finding heading MUST start with "## Finding N: " (h2, "Finding ", number, colon, title) — number sequentially from 1.',
      '- Severity / Location / Issue / Suggestion bullets are on their own lines with the labels exactly as shown.',
      '- Do NOT emit JSON. The structured reviewer extracts from this format; if that pass fails the deterministic fallback extracts from this same format — both produce identical structured output, so the format is the single source of truth.',
    );
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
  results: import('../../types.js').RunResult[],
  store: import('../../stores/context-block-tool.js').ContextBlockStore | undefined,
): string | undefined {
  if (!store) return undefined;
  const usable = results.filter(r => !r.outputIsDiagnostic && r.output.trim().length > 0);
  if (usable.length === 0) return undefined;
  const combined = usable.map(r => r.output).join('\n\n---\n\n');
  const { id } = store.register(combined);
  return id;
}

export interface AuditOutput extends ExecutorOutput {
  contextBlockId?: string;
}

export async function executeAudit(
  ctx: ExecutionContext,
  input: Input,
): Promise<AuditOutput> {
  const { config, contextBlockStore } = ctx;

  const hasContextBlocks = Array.isArray(input.contextBlockIds) && input.contextBlockIds.length > 0;

  const mainModel = ctx.mainModel ?? config.defaults?.mainModel ?? undefined;

  const baseTaskSpec: Partial<TaskSpec> = {
    agentType: 'complex',
    reviewPolicy: 'quality_only',
    briefQualityPolicy: 'off',
    done: resolveAuditDoneCondition(input.auditType, hasContextBlocks),
    tools: config.defaults?.tools ?? 'full',
    timeoutMs: config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    maxCostUSD: config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
    cwd: ctx.projectContext!.cwd,
    contextBlockIds: input.contextBlockIds,
    mainModel,
  };
  const runtime = contextBlockStore ? { contextBlockStore } : undefined;

  const mode = resolveDispatchMode(input.document, input.filePaths);

  if (mode === 'fan_out') {
    const validPaths = input.filePaths!.filter(p => p.trim().length > 0);
    const auditTypeText = resolveAuditTypeText(input.auditType);
    const promptTemplate = buildAuditPrompt(auditTypeText, undefined, undefined, hasContextBlocks);
    const tasks: TaskSpec[] = validPaths.map(fp => ({
      ...baseTaskSpec,
      prompt: buildPerFilePrompt(fp, promptTemplate),
    } as TaskSpec));

    const startMs = Date.now();
    let results: RunResult[];
    try {
      results = await runTasks(tasks, config, { runtime, ...(ctx.batchId !== undefined && { batchId: ctx.batchId }), ...(ctx.recordHeartbeat !== undefined && { recordHeartbeat: ctx.recordHeartbeat }), logger: ctx.logger, ...(ctx.recorder !== undefined && { recorder: ctx.recorder }), ...(ctx.route !== undefined && { route: ctx.route }), ...(ctx.client !== undefined && { client: ctx.client }), ...(ctx.triggeringSkill !== undefined && { triggeringSkill: ctx.triggeringSkill }), qualityReviewPromptBuilder: buildAuditQualityPrompt, reviewerEngine: createDefaultReviewerEngine(), annotatorEngine: createDefaultAnnotatorEngine() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results = [{ output: '', status: 'error' as const, usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 }, turns: 0, filesRead: [], filesWritten: [], toolCalls: [], outputIsDiagnostic: false, escalationLog: [], parsedFindings: null, error: msg, errorCode: 'runner_crash', retryable: false, durationMs: 0, structuredError: { code: 'runner_crash' as const, message: msg, where: 'executor:audit' }, workerStatus: 'failed' as const }];
    }
    const wallClockMs = Date.now() - startMs;
    const ctxId = autoRegisterContextBlock(results, contextBlockStore);
    const batchTimings = computeTimings(wallClockMs, results);
    const costSummary = computeAggregateCost(results);
    const verdicts = mapReviewVerdicts(results[0], false);

    return {
      headline: composeTerminalHeadline({ tool: 'audit', tasksTotal: tasks.length, tasksCompleted: results.length }),
      results,
      batchTimings,
      costSummary,
      structuredReport: notApplicable('no structured report emitted by this executor'),
      error: notApplicable('batch succeeded'),
      batchId: randomUUID(),
      wallClockMs,
      mainModel,
      ...verdicts,
      ...(ctxId !== undefined && { contextBlockId: ctxId }),
    };
  }

  // Single-task mode
  const auditTypeText = resolveAuditTypeText(input.auditType);
  const prompt = buildAuditPrompt(auditTypeText, input.document, input.filePaths, hasContextBlocks);
  const task = { ...baseTaskSpec, prompt } as TaskSpec;
  const startMs = Date.now();
  let result: RunResult;
  try {
    const resolved = resolveAgent('complex', config);
    result = await runTaskViaDispatcher({
      task,
      resolved,
      config,
      taskIndex: 0,
      batchId: ctx.batchId,
      recordHeartbeat: ctx.recordHeartbeat,
      logger: ctx.logger,
      verbose: config.diagnostics?.verbose ?? false,
      recorder: ctx.recorder,
      route: ctx.route ?? 'audit',
      client: ctx.client,
      triggeringSkill: ctx.triggeringSkill,
      bus: ctx.bus,
      qualityReviewPromptBuilder: buildAuditQualityPrompt,
      reviewerEngine: createDefaultReviewerEngine(),
      annotatorEngine: createDefaultAnnotatorEngine(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result = { output: '', status: 'error' as const, usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 }, turns: 0, filesRead: [], filesWritten: [], toolCalls: [], outputIsDiagnostic: false, escalationLog: [], parsedFindings: null, error: msg, errorCode: 'runner_crash', retryable: false, durationMs: 0, structuredError: { code: 'runner_crash' as const, message: msg, where: 'executor:audit' }, workerStatus: 'failed' as const };
  }
  const wallClockMs = Date.now() - startMs;
  const results = [result];
  const ctxId = autoRegisterContextBlock(results, contextBlockStore);
  const batchTimings = computeTimings(wallClockMs, results);
  const costSummary = computeAggregateCost(results);
  const verdicts = mapReviewVerdicts(result, false);

  return {
    headline: composeTerminalHeadline({ tool: 'audit', tasksTotal: 1, tasksCompleted: results.length }),
    results,
    batchTimings,
    costSummary,
    structuredReport: notApplicable('no structured report emitted by this executor'),
    error: notApplicable('batch succeeded'),
    batchId: randomUUID(),
    wallClockMs,
    mainModel,
    ...verdicts,
    ...(ctxId !== undefined && { contextBlockId: ctxId }),
  };
}
