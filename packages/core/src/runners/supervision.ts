import type { ProviderConfig } from '../types.js';
import type { TaskSpec, ProgressEvent } from '../types.js';
import type { ModelProfile } from '../routing/model-profiles.js';

/**
 * Sub-agent completion supervision.
 *
 * The runner calls validateCompletion() after every turn that ends without
 * a tool call (the SDK signal "agent done"). If the result is degenerate,
 * the runner injects a re-prompt and continues the loop instead of returning.
 *
 * See docs/superpowers/specs/2026-04-10-subagent-completion-supervision-design.md
 * Parts A.2.2 and A.4 for the full contract.
 *
 * --- @openai/agents SDK introspection finding (from Task 1, Step 1) ---
 * Happy path confirmed. The `@openai/agents` SDK (via @openai/agents-core)
 * exposes intermediate assistant text on the returned `RunResult`:
 *   - `result.newItems: RunItem[]` is a discriminated union where entries of
 *     type `"message_output_item"` are `RunMessageOutputItem` instances with
 *     `rawItem.role === "assistant"` and `rawItem.content` carrying
 *     `{ type: "output_text", text: string }` parts (plus `refusal`, `audio`,
 *     `image`). See node_modules/@openai/agents-core/dist/items.d.ts around
 *     line 337 (class RunMessageOutputItem) and dist/result.d.ts lines 17-76
 *     (RunResultData interface — `newItems`, `output`, `history`, `state`).
 *   - `result.state` additionally holds the full RunState, and
 *     StreamedRunResult exposes a `RunStreamEvent` async iterator for
 *     live mid-run observation if we ever need true streaming.
 * For our scratchpad needs the non-streaming path is sufficient: after any
 * `agentRun(...)` call (including iterative re-prompt turns), we can iterate
 * `result.newItems`, pick every `message_output_item`, concatenate its
 * `output_text` parts, and append the result to the TextScratchpad. This
 * gives us full intermediate salvage for openai-runner without dropping to
 * the lower-level OpenAI client or patching hooks. Task 3 should implement
 * this salvage extraction.
 * ----------------------------------------------------------------------
 */

/** Classification of a degenerate model response, including coverage failures. */
export type DegenerateKind =
  | 'empty'
  | 'thinking_only'
  | 'fragment'
  | 'no_terminator'
  | 'insufficient_coverage';

export interface ValidationResult {
  valid: boolean;
  kind?: DegenerateKind;
  reason?: string;
  /** Last 60 characters of the trimmed text, used by buildRePrompt. */
  tail?: string;
}

export interface ValidateCompletionOptions {
  minLength?: number;
}

export function validateCoverage(
  text: string,
  expected: NonNullable<TaskSpec['expectedCoverage']>,
): ValidationResult {
  if (expected.minSections !== undefined) {
    const pattern = expected.sectionPattern ?? '^## ';
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'gm');
    } catch (err) {
      return {
        valid: false,
        kind: 'insufficient_coverage',
        reason: `invalid sectionPattern regex: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const count = (text.match(re) ?? []).length;
    if (count < expected.minSections) {
      return {
        valid: false,
        kind: 'insufficient_coverage',
        reason: `only ${count} sections found, expected at least ${expected.minSections}`,
      };
    }
  }

  if (expected.requiredMarkers?.length) {
    const missing = expected.requiredMarkers.filter((marker) => !text.includes(marker));
    if (missing.length > 0) {
      const preview = missing.slice(0, 5).join(', ');
      const extra = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
      return {
        valid: false,
        kind: 'insufficient_coverage',
        reason: `only ${expected.requiredMarkers.length - missing.length} of ${expected.requiredMarkers.length} required markers found, missing: ${preview}${extra}`,
      };
    }
  }

  return { valid: true };
}

const DEFAULT_MIN_LENGTH = 200;

/** Tail window (chars) inspected by `endsWithContinuation` for continuation phrases. */
const CONTINUATION_TAIL_WINDOW = 80;

/** Tail length (chars) quoted back to the model in the re-prompt via `result.tail`. */
const REPROMPT_TAIL_QUOTE = 60;

/**
 * Marker returned by `stripThinkingTags` when the entire final message was
 * `<think>...` reasoning and stripping left nothing. Exported here
 * (rather than from openai-runner.ts) so that `validateCompletion` can detect
 * the marker without importing the runner, and so other runners can reuse it
 * when they implement their own thinking-only salvage. There is exactly one
 * canonical constant.
 */
export const THINKING_DIAGNOSTIC_MARKER =
  '[model final message contained only <think>...</think> reasoning, no plain-text answer]';

const CONTINUATION_PHRASES = [
  'let me',
  'let me check',
  'let me read',
  'let me look',
  'next i',
  "i'll continue",
  'i need to',
  "now i'll",
  'i should also',
  'checking',
  "i'll now",
];

const FRAGMENT_PUNCTUATION = [':', ',', '…'];

const TERMINAL_PUNCTUATION = ['.', '!', '?', '`', ')', ']', '}'];
const MARKDOWN_HINTS = [/^#{1,6} /m, /^- /m, /^\d+\. /m, /```/];

function endsWithContinuation(tail: string): boolean {
  const lower = tail.toLowerCase();
  return CONTINUATION_PHRASES.some((p) => lower.endsWith(p) || lower.includes(p));
}

function endsWithFragmentPunctuation(text: string): boolean {
  const trimmed = text.trimEnd();
  return FRAGMENT_PUNCTUATION.some((p) => trimmed.endsWith(p));
}

function hasMarkdownStructure(text: string): boolean {
  return MARKDOWN_HINTS.some((re) => re.test(text));
}

function endsWithTerminalPunctuation(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return false;
  const last = trimmed[trimmed.length - 1];
  return TERMINAL_PUNCTUATION.includes(last);
}

// Detector order is most-specific-first: empty → thinking_only → long-enough →
// markdown → fragment → no_terminator. Markdown precedes fragment so that
// `Here:\n\`\`\`...\`\`\`` passes as a valid short response; fragment precedes
// no_terminator because the fragment re-prompt (which quotes the continuation
// phrase back at the model) is more actionable than the generic no-terminator one.
export function validateCompletion(
  text: string,
  opts: ValidateCompletionOptions = {},
): ValidationResult {
  const minLength = opts.minLength ?? DEFAULT_MIN_LENGTH;

  if (!text || text.trim().length === 0) {
    return { valid: false, kind: 'empty', reason: 'response was empty' };
  }
  if (text.trim() === THINKING_DIAGNOSTIC_MARKER) {
    return {
      valid: false,
      kind: 'thinking_only',
      reason: 'response contained only <think> reasoning content',
    };
  }

  const trimmed = text.trim();
  const tail = trimmed.slice(-CONTINUATION_TAIL_WINDOW);

  // Long enough → trust the response.
  if (trimmed.length >= minLength) {
    return { valid: true };
  }

  // Short responses are valid only if they look complete (terminal punctuation
  // or markdown structure). Without that, they're either fragments or
  // unterminated.
  const hasMarkdown = hasMarkdownStructure(trimmed);
  if (hasMarkdown) {
    return { valid: true };
  }

  if (endsWithFragmentPunctuation(trimmed) || endsWithContinuation(tail)) {
    return {
      valid: false,
      kind: 'fragment',
      reason: 'response is short and ends like an exploration fragment',
      tail: trimmed.slice(-REPROMPT_TAIL_QUOTE),
    };
  }

  if (!endsWithTerminalPunctuation(trimmed)) {
    return {
      valid: false,
      kind: 'no_terminator',
      reason: 'response is short and has no terminal punctuation or markdown structure',
      tail: trimmed.slice(-REPROMPT_TAIL_QUOTE),
    };
  }

  return { valid: true };
}

export function buildRePrompt(result: ValidationResult): string {
  if (result.valid) {
    throw new Error('buildRePrompt called on a valid response — this is a bug');
  }

  switch (result.kind) {
    case 'empty':
      return [
        'Your previous response was empty. You did not produce a final answer to the task',
        'and did not call any tools. Please respond again with your complete final answer',
        'as plain text in this assistant message. The final answer is what gets returned',
        'to the caller — there are no follow-up turns after you produce it. If you are not',
        'yet done, call the tools you need first; otherwise produce the final answer now.',
      ].join(' ');

    case 'thinking_only':
      return [
        'Your previous response contained only <think>... reasoning, with no',
        'plain-text answer outside the tags. The reasoning tags are stripped before the',
        'response is returned to the caller, so a thinking-only response is equivalent',
        'to no response at all. Please respond again with your complete final answer as',
        'plain text outside any reasoning tags.',
      ].join(' ');

    case 'fragment': {
      const tail = result.tail ?? '';
      return [
        `Your previous response was an exploration fragment (it ended with "${tail}")`,
        'rather than a final answer. You appear to have stopped mid-thought instead of',
        'completing the task. Either: (a) continue exploring by calling the tools you',
        'need, then produce your final answer, or (b) produce your complete final answer',
        'now with whatever you have gathered so far — partial answers are acceptable and',
        'useful, empty responses are not. Your final answer must be a plain-text',
        'assistant message, not a tool call and not a thinking block.',
      ].join(' ');
    }

    case 'no_terminator': {
      const tail = result.tail ?? '';
      return [
        `Your previous response appears to have stopped mid-thought (it ended with`,
        `"${tail}"). Please produce your complete final answer with terminal punctuation`,
        'or proper markdown structure. If you are still working, call the tools you need',
        'first; otherwise produce the final answer now.',
      ].join(' ');
    }

    case 'insufficient_coverage':
      return `Your previous answer was structurally valid but does not cover everything the brief required: ${result.reason}. Continue your report by addressing the missing items. Do NOT restart from the beginning — append the missing sections to what you already wrote.`;

    default:
      return 'Your previous response was incomplete. Please produce your complete final answer as plain text.';
  }
}

/**
 * Compares two consecutive degenerate outputs for byte equality. Used by
 * the supervision loop's same-output early-out: if the model produces
 * identical garbage twice in a row, give up immediately instead of
 * burning the third retry.
 */
export function sameDegenerateOutput(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * Resolves the effective inputTokenSoftLimit for a (provider, profile) pair.
 *
 * Precedence: `config.inputTokenSoftLimit` (user override) wins over
 * `profile.inputTokenSoftLimit` (family default).
 *
 * Both fields are Zod-validated upstream:
 *   - `ProviderConfig.inputTokenSoftLimit` — `z.number().int().positive().optional()`
 *     (see packages/core/src/config/schema.ts)
 *   - `ModelProfile.inputTokenSoftLimit` — `z.number().int().positive()` (required)
 *
 * Because profile is guaranteed to carry a positive integer (DEFAULT_PROFILE
 * supplies `100_000` when no prefix matches), there is no hardcoded
 * constant fallback — the DEFAULT_PROFILE value is the de-facto fallback
 * for unprofiled model IDs.
 */
export function resolveInputTokenSoftLimit(
  config: ProviderConfig,
  profile: ModelProfile,
): number {
  return config.inputTokenSoftLimit ?? profile.inputTokenSoftLimit;
}

export type WatchdogStatus = 'ok' | 'warning' | 'force_salvage';

/**
 * Watchdog threshold ratios (fraction of the resolved `softLimit`).
 * Exported so tests can reference the exact boundary values.
 *
 * - At/above `WATCHDOG_WARNING_RATIO` (80%) the supervision loop nudges
 *   the model toward salvage.
 * - At/above `WATCHDOG_FORCE_SALVAGE_RATIO` (95%) the loop is forcibly
 *   terminated and the scratchpad is salvaged.
 */
export const WATCHDOG_WARNING_RATIO = 0.80;
export const WATCHDOG_FORCE_SALVAGE_RATIO = 0.95;

/**
 * Given the cumulative input token usage and the resolved soft limit,
 * returns the watchdog status:
 *   - 'ok'             below 80%
 *   - 'warning'        at or above 80%, below 95% (model is nudged)
 *   - 'force_salvage'  at or above 95% (loop is forcibly terminated)
 *
 * Throws if `softLimit` is not a positive finite number. Runners call
 * this independently, so a silent `'ok'` on a bad limit would mask
 * upstream config bugs.
 */
export function checkWatchdogThreshold(
  cumulativeInputTokens: number,
  softLimit: number,
): WatchdogStatus {
  if (!Number.isFinite(softLimit) || !(softLimit > 0)) {
    throw new Error(
      `checkWatchdogThreshold: softLimit must be a positive finite number, got ${softLimit}`,
    );
  }
  const ratio = cumulativeInputTokens / softLimit;
  if (ratio >= WATCHDOG_FORCE_SALVAGE_RATIO) return 'force_salvage';
  if (ratio >= WATCHDOG_WARNING_RATIO) return 'warning';
  return 'ok';
}

export interface WatchdogEventDetails {
  provider: string;
  model: string;
  turn: number;
  inputTokens: number;
  softLimit: number;
  scratchpadChars: number;
}

/**
 * Emits a structured log line at watchdog threshold crossings.
 *
 * Gated on the `MULTI_MODEL_DEBUG` environment variable: the function is
 * a no-op unless `process.env.MULTI_MODEL_DEBUG === '1'`. Any other value
 * (including `'true'`, `'yes'`, or unset) suppresses the log.
 *
 * When enabled, a single line is written to `stderr` via `console.error`
 * of the form:
 *   `[multi-model-agent] WATCHDOG <status>: provider=… model=… turn=… inputTokens=… softLimit=… percentOfLimit=… [scratchpadChars=…]`
 *
 * `scratchpadChars` is only appended when `status === 'force_salvage'`,
 * since that is the transition where salvage content size matters for
 * calibration. Used for empirical calibration of the 80% / 95%
 * thresholds. See spec Part A.1.4 calibration logging.
 */
export function logWatchdogEvent(
  status: 'warning' | 'force_salvage',
  details: WatchdogEventDetails,
): void {
  if (process.env.MULTI_MODEL_DEBUG !== '1') return;
  const percent = Math.round((details.inputTokens / details.softLimit) * 100);
  const parts = [
    `[multi-model-agent] WATCHDOG ${status}:`,
    `provider=${details.provider}`,
    `model=${details.model}`,
    `turn=${details.turn}`,
    `inputTokens=${details.inputTokens}`,
    `softLimit=${details.softLimit}`,
    `percentOfLimit=${percent}`,
  ];
  if (status === 'force_salvage') {
    parts.push(`scratchpadChars=${details.scratchpadChars}`);
  }
  console.error(parts.join(' '));
}

/** camelCase tool names (matching tracker.trackToolCall format in definitions.ts)
 *  that indicate file-level artifact production. */
export const FILE_MUTATING_TOOLS = new Set(['writeFile', 'editFile']);

export function extractToolName(toolCallEntry: string): string {
  const parenIndex = toolCallEntry.indexOf('(');
  return parenIndex === -1 ? toolCallEntry : toolCallEntry.slice(0, parenIndex);
}

export function hasCompletedWork(toolCalls: string[]): boolean {
  return toolCalls.some(tc => FILE_MUTATING_TOOLS.has(extractToolName(tc)));
}

/**
 * Coordinator for sub-agent output validation.
 *
 * Replaces the runner-side coordination pattern where each runner called
 * `validateCompletion` first and then (optionally) `validateCoverage`. That
 * ordering had a bug: short, correct outputs on tight-format tasks tripped
 * the `no_terminator` heuristic BEFORE the more authoritative coverage
 * check had a chance to run, causing false-positive `incomplete` statuses.
 *
 * New priority order:
 *
 *   1. `empty` and `thinking_only` always fail first — these are "is
 *      there content at all" signals, not "is the content done" signals.
 *   2. If `expectedCoverage` is declared and passes, the output is valid
 *      regardless of short-output heuristics. Coverage is authoritative.
 *   3. If `expectedCoverage` is declared and fails, return the coverage
 *      failure.
 *   4. If `skipCompletionHeuristic` is set, the short-output heuristic is
 *      skipped (only empty / thinking_only fire). Use this for tight-format
 *      tasks that don't declare coverage.
 *   5. Otherwise, fall through to the full `validateCompletion` heuristic
 *      (the existing behavior).
 *
 * The underlying `validateCompletion` and `validateCoverage` functions are
 * NOT modified — this is a pure coordination wrapper.
 */
export function validateSubAgentOutput(
  text: string,
  opts: {
    expectedCoverage?: TaskSpec['expectedCoverage'];
    skipCompletionHeuristic?: boolean;
  } = {},
): ValidationResult {
  const completion = validateCompletion(text);
  if (
    !completion.valid &&
    (completion.kind === 'empty' || completion.kind === 'thinking_only')
  ) {
    return completion;
  }

  if (opts.expectedCoverage) {
    const coverage = validateCoverage(text, opts.expectedCoverage);
    if (!coverage.valid) return coverage;
    return { valid: true };
  }

  if (opts.skipCompletionHeuristic) {
    return { valid: true };
  }

  return completion;
}
