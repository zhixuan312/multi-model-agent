import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { qualityReviewTemplate } from '../../review/templates/quality-review-review.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { ExecutionContext } from '../../lifecycle/lifecycle-context.js';
import { reviewBriefSlot, type ReviewBrief } from '../../intake/brief-compiler-slots/review.js';
import { reviewReportSchema } from '../../reporting/report-parser-slots/review-report.js';
import { reviewHeadlineTemplate } from '../../reporting/headline-templates/review.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';
import { SEVERITY_LADDER } from '../../review/templates/finding-criteria.js';
import {
  REVIEW_PURPOSE_ORIENTATION,
  EVIDENCE_RULE_REVIEW,
  SCOPE_RULE_REVIEW,
  ANNOTATOR_AWARENESS_REVIEW,
  CODE_REVIEW_FAILURE_MODES,
  THOROUGHNESS_REMINDER_REVIEW,
} from './implementer-criteria.js';

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

function buildReviewPrompt(brief: ReviewBrief): string {
  const { code, filePaths, focus, hasContextBlocks, filePath } = brief;
  const parts: string[] = ['Review this code:'];

  if (filePath) {
    parts.push(`Read and analyze this file:\n- ${filePath}`);
  } else {
    if (code) parts.push(`\`\`\`\n${code}\n\`\`\``);
    if (filePaths && filePaths.length > 0) {
      parts.push(`Read and analyze these files:\n${filePaths.map(p => `- ${p}`).join('\n')}`);
    }
    if (focus && focus.length > 0) parts.push(`Focus areas: ${focus.join(', ')}.`);
  }

  // Tool sweep #11: emit format spec unconditionally (pre-fix the
  // DELTA branch dropped it, breaking annotator parse on delta runs).
  if (hasContextBlocks) {
    parts.push(
      'A prior review is in the context above. **Omit** addressed findings, **include** still-present ones (mark "unfixed from prior review"), **include** any new findings, and end with a **Fixed** summary.',
    );
  }
  parts.push(FINDING_FORMAT_INSTRUCTIONS);

  return parts.join('\n\n');
}

const FINDING_FORMAT_INSTRUCTIONS = [
  // Orientation goes FIRST — the worker needs to know why this review
  // exists (pre-merge gate, your verdict is authoritative, missing a
  // regression here ships) before reading the format spec / taxonomy /
  // evidence rules. Without it, workers do line-by-line proofreading and
  // miss cross-file ripples and test gaps.
  REVIEW_PURPOSE_ORIENTATION,
  '',
  'Produce a narrative code review. Use this EXACT per-finding format — both the structured reviewer and the deterministic fallback extract from this same format:',
  '',
  '## Finding 1: <one-line title>',
  '- Severity: critical | high | medium | low',
  '- Location: file:line',
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
  '- If you found no issues, say "No findings." in plain prose and emit zero `## Finding N:` blocks.',
  '',
  SEVERITY_LADDER,
  '',
  // Code-review failure-mode taxonomy. Without this block, workers
  // calibrated on line-by-line proofreading miss the cross-file ripple,
  // test gap, and implicit-contract findings that actually block merges.
  CODE_REVIEW_FAILURE_MODES,
  '',
  // Counter-balances the SEVERITY_LADDER's anti-inflation hint and
  // includes the cross-file pass with worked example.
  THOROUGHNESS_REMINDER_REVIEW,
  '',
  EVIDENCE_RULE_REVIEW,
  '',
  SCOPE_RULE_REVIEW,
  '',
  ANNOTATOR_AWARENESS_REVIEW,
].join('\n');

export const toolConfig: ToolConfig<Input, ReviewBrief, unknown> = {
  name: 'review',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: reviewBriefSlot,
  buildTaskSpec: (brief, ctx) => {
    const prompt = buildReviewPrompt(brief);
    // Propagate filePaths + mainModel onto the TaskSpec so the headline
    // composer can name the file in clean-review headlines and so the
    // wire telemetry carries main_model attribution. Audit does this
    // already; review missed it, producing "[ok] review completed"
    // (no path) even when filePaths was provided. (Tool sweep #2 — gap surfaced
    // by review batch c24353f6 on packages/core/src/reporting/severity.ts.)
    const filePaths = brief.filePath
      ? [brief.filePath]
      : (brief.filePaths && brief.filePaths.length > 0 ? brief.filePaths : undefined);
    const targetParts: string[] = ['Review this code:'];
    if (brief.code) targetParts.push('```\n' + brief.code + '\n```');
    if (filePaths && filePaths.length > 0) {
      targetParts.push(`Target files:\n${filePaths.map(p => `- ${p}`).join('\n')}`);
    }
    if (brief.focus) targetParts.push(`Focus: ${Array.isArray(brief.focus) ? brief.focus.join(', ') : brief.focus}`);
    return {
      prompt,
      // Pure user code/files for the parallel-criteria dispatcher's cached
      // prefix; bypasses the legacy ## Finding format spec embedded in `prompt`.
      parallelTarget: targetParts.join('\n\n'),
      agentType: 'complex',
      reviewPolicy: 'none',
      briefQualityPolicy: 'off',
      done: resolveReviewDoneCondition(brief.focus, brief.hasContextBlocks),
      tools: ctx.config.defaults?.tools ?? 'full',
      timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      maxCostUSD: ctx.config.defaults?.maxCostUSD ?? 10,
      sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
      cwd: ctx.projectContext?.cwd ?? ctx.cwd,
      contextBlockIds: brief.contextBlockIds,
      filePaths,
      mainModel: ctx.mainModel ?? undefined,
      autoCommit: false,
    };
  },
  reportSchema: reviewReportSchema,
  headlineTemplate: reviewHeadlineTemplate,
  reviewTemplates: {
    qualityAP: qualityReviewTemplate,
  },
};
