/**
 * Sub-agent prevention layer.
 *
 * Provides the strong default system prompt, the budget hint preamble,
 * and the periodic re-grounding message that the runners inject to keep
 * the model focused. The goal is to make the first attempt succeed.
 *
 * All builders here MUST be deterministic: same input → byte-identical
 * output. No Date.now(), no Math.random(), no environment variable
 * leakage. Tests in tests/runners/prevention.test.ts assert this.
 *
 * See spec Part A.1 for the design rationale.
 */

import type { FormatConstraints } from '../types.js';

export function buildSystemPrompt(): string {
  return [
    'You are a sub-agent completing a single task end-to-end. Read these rules before you begin any tool calls.',
    '',
    'The deliverable. Your final assistant message — and only your final assistant message — is what gets returned to the caller. Intermediate tool outputs and earlier turns are discarded. Your final message must be complete, substantive, and in plain text. Content inside <think> tags is stripped — only plain text reaches the caller.',
    '',
    'Plan before you act. Before your first tool call, identify (1) what the task is asking for, (2) its success criteria (output format, required sections, acceptance tests), (3) what files or information you need, and (4) how many tool calls you expect. State this plan in your first assistant message.',
    '',
    'Tool rules:',
    '- Use grep to locate content. Use readFile when you need the full file context that grep cannot provide.',
    '- Read each file at most once. Note relevant parts in your assistant messages for later reference. Exception: re-read after editing to confirm the edit landed.',
    '- Use glob to find files by name, then grep to search inside them.',
    '- Batch grep patterns: use regex alternation (a|b|c) in one call, not separate calls per pattern.',
    '- Use edit_file to modify part of a file. Provide enough surrounding context in oldContent to match exactly one location. Use write_file only to create new files or rewrite an entire file.',
    '',
    'Shell rules:',
    '- Use run_shell to run tests, build, and execute any command-line task the brief requires.',
    '- In parallel tasks, run targeted tests (e.g., "npx vitest run tests/specific.test.ts") instead of full suites (e.g., "npm test").',
    '- Use edit_file or write_file for all file modifications. Shell-based edits (sed, awk, perl -i) are error-prone and not tracked by the harness.',
    '- Only install packages, run destructive commands, or modify system state when the task explicitly requests it.',
    '',
    'Progress and completion:',
    '- Write findings as you discover them in your assistant turns. This is saved in the scratchpad and recovered if the run is interrupted.',
    '- Always execute tool calls you describe. If you write "let me check X next", call the tool immediately or produce your final answer.',
    '- If you hit a problem (tool failure, missing file, unclear task), produce a partial answer explaining what you found and what blocked you.',
    '',
    'Output format: if the task specifies a format, follow it exactly. Match headers, table structures, prefixes (e.g., "start with # Gap Report:"), and section order. The caller validates the format.',
  ].join('\n');
}

export interface BuildBudgetHintOptions {
  maxTurns: number;
}

export function buildBudgetHint(opts: BuildBudgetHintOptions): string {
  const half = Math.floor(opts.maxTurns / 2);
  return [
    `Budget: you have ${opts.maxTurns} tool calls for this task.`,
    'Batch your investigation using recursive grep over file-by-file reads. Write findings as you go.',
    `At ${half} calls, start drafting your final answer.`,
  ].join(' ');
}

export const RE_GROUNDING_INTERVAL_TURNS = 10;

export interface BuildReGroundingMessageOptions {
  originalPromptExcerpt: string;
  currentTurn: number;
  maxTurns: number;
  toolCallsSoFar: number;
  filesReadSoFar: number;
}

export function buildReGroundingMessage(opts: BuildReGroundingMessageOptions): string {
  const percent = Math.round((opts.currentTurn / opts.maxTurns) * 100);
  const excerpt = opts.originalPromptExcerpt.slice(0, 200);
  return [
    `Reminder: your task is "${excerpt}${opts.originalPromptExcerpt.length > 200 ? '...' : ''}".`,
    `You are at turn ${opts.currentTurn} of ${opts.maxTurns} (≈ ${percent}% of budget used).`,
    `Tool calls so far: ${opts.toolCallsSoFar}. Files read: ${opts.filesReadSoFar}.`,
    'Start drafting your final answer now.',
    'Use your remaining budget to fill gaps, then finalize.',
  ].join(' ');
}

export interface BuildBudgetPressureNudgeOptions {
  inputTokens: number;
  softLimit: number;
}

/**
 * Nudge message the runner injects when the watchdog crosses its
 * `warning` threshold (see supervision.checkWatchdogThreshold). The text
 * is deliberately terse: the model is already close to the soft limit, so
 * we tell it to stop exploring and produce a final answer from whatever
 * it has gathered. Kept here so every runner (openai, claude, codex)
 * uses byte-identical wording.
 */
export function buildBudgetPressureNudge(opts: BuildBudgetPressureNudgeOptions): string {
  return (
    `Budget pressure: you have used approximately ${opts.inputTokens} ` +
    `input tokens out of a soft limit of ${opts.softLimit}. ` +
    `Produce your complete final answer now with whatever you have gathered.`
  );
}

export function buildFormatConstraintSuffix(constraints: FormatConstraints): string {
  if (!constraints.inputFormat && !constraints.outputFormat) return '';
  
  const parts: string[] = [];
  if (constraints.inputFormat) {
    parts.push(`input format: ${constraints.inputFormat}`);
  }
  if (constraints.outputFormat) {
    parts.push(`output format: ${constraints.outputFormat}`);
  }
  
  return '\n\n' + parts.join(' ');
}
