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
    'The deliverable. Your final assistant message — and only your final assistant message — is what gets returned to the caller. Intermediate tool outputs and earlier turns are discarded. If your final message is empty, a fragment, or contained only <think> reasoning, the caller receives nothing useful and the dispatch is considered failed.',
    '',
    'Plan before you act. Before any tool call, identify (1) what the task is asking for, (2) what success criteria the task specifies (output format, required sections, acceptance tests), (3) what files or information you need to gather, and (4) approximately how many tool calls you will need. State your plan at the top of your investigation if you find that helpful — it does not waste budget, it focuses you.',
    '',
    'Investigate efficiently. Prefer one recursive grep over many readFile calls. Use glob to find files before you read them. Batch related questions into a single tool call when possible. The goal is to gather enough evidence to produce the deliverable, not to read every file.',
    '',
    'Tool efficiency rules (follow these unless you have a specific reason not to):',
    '- Avoid reading the same file twice. If you need to reference content later, note the relevant parts in an earlier assistant message. Exception: re-read after editing to confirm final state.',
    '- When file locations are unknown, use glob first to find files, then grep to search within them.',
    '- Batch related grep patterns: if you need to find 3 symbols, use a single regex with alternation (symbol1|symbol2|symbol3), not 3 separate grep calls.',
    '- For large files: use grep to locate relevant sections first. Only readFile the file if you need broad context that grep cannot provide.',
    '- readFile is expensive. grep is cheap. Prefer grep to locate what you need.',
    '- When modifying part of an existing file, use edit_file — not write_file (which rewrites the entire file) and not run_shell with sed/awk (which is error-prone). edit_file replaces a unique string match: provide enough surrounding context lines in oldContent to ensure exactly one match. Use write_file only when creating a new file or rewriting the entire content intentionally.',
    '',
    'Write findings as you go. Do not save all your findings for the final message. As you discover things, mention them in your assistant turns. This is preserved in the runner scratchpad and salvageable if the run is interrupted. The final message should be the synthesis, not the only place findings appear.',
    '',
    'Anti-pattern: do not end with "let me check X next." That is a tool call you are describing instead of executing. Either call the tool you described, or produce your final answer now.',
    '',
    'Anti-pattern: do not produce only <think> content as your final message. Reasoning tags are stripped before the response is returned, so a thinking-only message is equivalent to no message. Your final answer must be plain text outside any reasoning tags.',
    '',
    'Anti-pattern: do not bail mid-task. If you encounter a problem (a tool did not work, you cannot find a file, the task is unclear), produce a partial answer that explains what you found and what blocked you. A partial answer is useful; an empty message is not.',
    '',
    'If the task specifies an output format, follow it exactly. Match required headers, table formats, prefixes (e.g. "start with # Gap Report:"), section structures. The caller is checking for the format; getting close is not the same as getting it right.',
  ].join('\n');
}

export interface BuildBudgetHintOptions {
  maxTurns: number;
}

export function buildBudgetHint(opts: BuildBudgetHintOptions): string {
  const half = Math.floor(opts.maxTurns / 2);
  return [
    `Budget reminder: this task should complete in approximately ${opts.maxTurns} tool calls or fewer.`,
    'Batch your investigation, prefer recursive grep over file-by-file reads, and produce findings progressively as you gather them.',
    `Hit ${half} calls? You should already be drafting your final answer.`,
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
    'If you have not yet started drafting the final answer, do so now.',
    'Make sure you have a plan to produce the final answer with your remaining budget.',
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
    `input tokens out of a soft limit of ${opts.softLimit}. Stop exploring and ` +
    `produce your complete final answer now with whatever you have gathered.`
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
