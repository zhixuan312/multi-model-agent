import type { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import { reviewBriefSlot, type ReviewBrief } from './brief-slot.js';
import { noStructuredReportSchema } from '../../reporting/report-parser-slots/no-structured-report.js';
import { makeFindingsHeadlineTemplate } from '../../reporting/findings-headline.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';

export function registerReview(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'review',
    httpMethod: 'POST',
    httpPath: '/review',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

/**
 * Per-focus "done" conditions.
 *
 * The full failure-mode taxonomy in CODE_REVIEW_FAILURE_MODES applies to
 * all reviews regardless of focus. These per-focus conditions tell the
 * worker which lens to weight, not which categories to skip. Security,
 * performance, and correctness lenses are universally applicable to
 * every code change — the focus array picks emphasis, not gating.
 *
 * When focus is empty/missing, the worker performs a comprehensive sweep
 * applying all four lenses with the executability/merge-safety
 * orientation block at the top of the prompt.
 */
const REVIEW_DONE_CONDITIONS: Record<string, string> = {
  security:
    'Lens emphasis: security. Apply the full failure-mode taxonomy through the security lens: auth bypass, injection (SQL/command/prompt), untrusted input flowing to a sink (eval/exec/HTML), data exposure, weakened sandboxing, and hardcoded secrets. Each finding has severity, location, and remediation.',
  performance:
    'Lens emphasis: performance. Apply the full failure-mode taxonomy through the performance lens: N+1 queries, unbounded loops, blocking I/O on hot paths, unnecessary deep clones, work shifted from build/init time to request time, and missing caching where the same value is recomputed. Each finding has impact level, location, and fix recommendation.',
  correctness:
    'Lens emphasis: correctness. Apply the full failure-mode taxonomy through the correctness lens: logic errors, off-by-one, unhandled edge cases (null/undefined/empty/timeout/error/zero/negative), type mismatches, contract violations, race conditions, and resource leaks. Each finding has severity, location, and correct behavior.',
  style:
    'Lens emphasis: style. Apply the full failure-mode taxonomy through the style lens: naming, formatting, dead code, inconsistent patterns, deprecated APIs, and missing types. Note: style is rarely the highest-value review lens for a non-trivial diff — sweep the correctness, security, and performance categories too.',
};

const DELTA_REVIEW_SUFFIX = ' Perform a full review (do not reduce thoroughness). Verify each prior finding as addressed or unaddressed. Omit addressed prior findings. Include unaddressed prior findings and new findings. End with a summary of which prior findings were resolved.';

function resolveReviewDoneCondition(focus: string[] | undefined, hasContextBlocks: boolean): string {
  let base: string;
  if (!focus || focus.length === 0) {
    base = 'Comprehensive code review. Apply the full failure-mode taxonomy (the orientation block above) through all four lenses (correctness, security, performance, style). Emphasize TEST GAP, CROSS-FILE RIPPLE, MISSING EDGE CASE, and IMPLICIT-CONTRACT ASSUMPTION — these are the categories most often missed and most likely to ship regressions. Each finding has category, severity, location, and recommendation.';
  } else {
    base = focus.map(f => REVIEW_DONE_CONDITIONS[f] ?? '').filter(Boolean).join(' ');
  }
  return hasContextBlocks ? base + DELTA_REVIEW_SUFFIX : base;
}

export const toolConfig: ToolConfig<Input, ReviewBrief, unknown> = {
  name: 'review',
  category: 'read_only',
  dispatchMode: 'parallel',
  dispatchModeOverridable: false,
  agentType: 'complex',
  briefSlot: reviewBriefSlot,
  buildTaskSpec: (brief, ctx) => {
    // Propagate filePaths + mainModel onto the TaskSpec so the headline
    // composer can name the file in clean-review headlines and so the
    // wire telemetry carries main_model attribution.
    const filePaths = brief.filePath
      ? [brief.filePath]
      : (brief.filePaths && brief.filePaths.length > 0 ? brief.filePaths : undefined);
    const targetParts: string[] = ['Review this code:'];
    if (brief.code) targetParts.push('```\n' + brief.code + '\n```');
    if (filePaths && filePaths.length > 0) {
      targetParts.push(`Target files:\n${filePaths.map(p => `- ${p}`).join('\n')}`);
    }
    if (brief.focus) targetParts.push(`Focus: ${Array.isArray(brief.focus) ? brief.focus.join(', ') : brief.focus}`);
    // The read-route dispatcher builds the worker prefix from this pure target
    // + FINDING_FORMAT_SHARED + review RouteSemantics; `prompt` mirrors it
    // (required field / telemetry, not the read-route worker input).
    const target = targetParts.join('\n\n');
    return {
      prompt: target,
      readTarget: target,
      agentType: 'complex',
      reviewPolicy: 'none',
      briefQualityPolicy: 'off',
      done: resolveReviewDoneCondition(brief.focus, brief.hasContextBlocks),
      tools: ctx.config.defaults?.tools ?? 'full',
      timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
      cwd: ctx.projectContext?.cwd ?? ctx.cwd,
      contextBlockIds: brief.contextBlockIds,
      filePaths,
      mainModel: ctx.mainModel ?? undefined,
    };
  },
  reportSchema: noStructuredReportSchema,
  headlineTemplate: makeFindingsHeadlineTemplate('review', 'blocking'),
};
