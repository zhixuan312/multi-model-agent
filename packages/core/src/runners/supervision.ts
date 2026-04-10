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

export type DegenerateKind = 'empty' | 'thinking_only' | 'fragment' | 'no_terminator';

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

const DEFAULT_MIN_LENGTH = 200;

const THINKING_DIAGNOSTIC_MARKER = '[model final message contained only <think>...</think> reasoning, no plain-text answer]';

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
  const tail = trimmed.slice(-80);

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
      tail: trimmed.slice(-60),
    };
  }

  if (!endsWithTerminalPunctuation(trimmed)) {
    return {
      valid: false,
      kind: 'no_terminator',
      reason: 'response is short and has no terminal punctuation or markdown structure',
      tail: trimmed.slice(-60),
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
        'Your previous response contained only <think>...</think> reasoning, with no',
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
  if (a.length === 0 || b.length === 0) return false;
  return a === b;
}
