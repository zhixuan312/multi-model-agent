import {
  Agent,
  run as agentRun,
  setTracingDisabled,
  OpenAIChatCompletionsModel,
  MaxTurnsExceededError,
} from '@openai/agents';
import type { RunItem, AgentInputItem } from '@openai/agents';
import OpenAI from 'openai';
import {
  withTimeout,
  computeCostUSD,
  type RunResult,
  type RunOptions,
  type ProviderConfig,
} from '../types.js';

/**
 * Structural view of `RunResult` from @openai/agents. We intentionally do
 * not import the nominal `RunResult` class: its generic parameter is
 * `Agent<TContext, TOutputType>` with `TOutputType extends AgentOutputType`,
 * and the `Agent` we construct below narrows `TOutputType` to the literal
 * `"text"`. That narrowed generic is NOT assignable to the
 * `AgentOutputType` constraint — TypeScript variance trips over the
 * `handoffs: Agent<any, TOutputType>[]` field. Using a structural interface
 * sidesteps the generic dance while still type-checking every field we
 * actually touch (.state.usage, .history, .finalOutput, .newItems).
 *
 * If the SDK ever changes these field names, the compiler will catch it at
 * the call sites rather than here — which is exactly what we want.
 */
interface AgentRunOutput {
  state: { usage: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number } };
  history: AgentInputItem[];
  finalOutput?: string;
  newItems: RunItem[];
}
import { FileTracker } from '../tools/tracker.js';
import { createToolImplementations } from '../tools/definitions.js';
import { createOpenAITools } from '../tools/openai-adapter.js';
import { TextScratchpad } from '../tools/scratchpad.js';
import {
  buildSystemPrompt,
  buildBudgetHint,
  buildReGroundingMessage,
  RE_GROUNDING_INTERVAL_TURNS,
} from './prevention.js';
import {
  validateCompletion,
  buildRePrompt,
  sameDegenerateOutput,
  resolveInputTokenSoftLimit,
  checkWatchdogThreshold,
  logWatchdogEvent,
  THINKING_DIAGNOSTIC_MARKER,
} from './supervision.js';
import { findModelProfile } from '../routing/model-profiles.js';

// Disable tracing — not all OpenAI-compatible providers support it
setTracingDisabled(true);

/**
 * Remove `<think>...</think>` reasoning blocks from model output.
 *
 * Several reasoning models (MiniMax, DeepSeek, Qwen variants) emit their
 * chain-of-thought inline wrapped in `<think>...</think>` tags. These are
 * scratch-pad content and should not surface to the caller. Stripping is
 * non-greedy, multi-line, and handles multiple blocks.
 *
 * If the entire input was reasoning (stripping leaves nothing), return an
 * explicit marker instead of an empty string. Silently swallowing
 * "all thinking, no answer" responses leaves the caller with `output: ""`
 * and no idea what happened — see the openai-runner empty-output diagnostic.
 */
export function stripThinkingTags(text: string): string {
  if (!text) return '';
  const stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trimStart();
  if (!stripped && /<think>[\s\S]*?<\/think>/i.test(text)) {
    return THINKING_DIAGNOSTIC_MARKER;
  }
  return stripped;
}

export interface OpenAIRunnerOptions {
  client: OpenAI;
  providerConfig: ProviderConfig;
  defaults: { maxTurns: number; timeoutMs: number; tools: 'none' | 'full' };
}

/**
 * Hard cap on supervision re-prompts before we give up and salvage. Three is
 * the value chosen in the spec (A.2.2): enough room for the model to recover
 * from a one-off fragment but not so many that a wedged model can burn the
 * budget via repeated re-prompts.
 */
const MAX_SUPERVISION_RETRIES = 3;

/**
 * Extract every assistant text emission from a single `agentRun(...)` result.
 * See the SDK introspection finding in supervision.ts: `result.newItems` is a
 * discriminated union and entries of type `"message_output_item"` wrap an
 * `AssistantMessageItem` whose `content` is a list of `{ type: 'output_text',
 * text }` / `refusal` / `audio` / `image` parts. We concatenate every
 * `output_text` part from every assistant `message_output_item`. Refusals
 * and non-text parts are ignored (they have no salvage value for a
 * text-in-text-out sub-agent).
 */
function extractAssistantText(newItems: RunItem[]): string {
  const chunks: string[] = [];
  for (const item of newItems) {
    if (item.type !== 'message_output_item') continue;
    const raw = item.rawItem;
    if (raw.role !== 'assistant') continue;
    const content = raw.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === 'output_text' && typeof part.text === 'string') {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join('');
}

export async function runOpenAI(
  prompt: string,
  options: RunOptions,
  runner: OpenAIRunnerOptions,
): Promise<RunResult> {
  const maxTurns = options.maxTurns ?? runner.providerConfig.maxTurns ?? runner.defaults.maxTurns;
  const timeoutMs = options.timeoutMs ?? runner.providerConfig.timeoutMs ?? runner.defaults.timeoutMs;
  const toolMode = options.tools ?? runner.defaults.tools;
  const cwd = options.cwd ?? process.cwd();
  const effort = options.effort ?? runner.providerConfig.effort;

  const sandboxPolicy = options.sandboxPolicy ?? runner.providerConfig.sandboxPolicy ?? 'cwd-only';
  const abortController = new AbortController();

  const tracker = new FileTracker();
  const toolImpls = createToolImplementations(tracker, cwd, sandboxPolicy, abortController.signal);
  const fileTools = toolMode === 'full' ? createOpenAITools(toolImpls, sandboxPolicy) : [];

  // Add hosted tools (web_search, image_generation, etc.) if configured — only when tools are enabled
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hostedTools = toolMode === 'full'
    ? (runner.providerConfig.hostedTools ?? []).map(t => ({ type: t } as any))
    : [];
  const tools = [...fileTools, ...hostedTools];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new OpenAIChatCompletionsModel(runner.client as any, runner.providerConfig.model);

  // --- Prevention layer: system prompt + budget hint ---
  //
  // buildSystemPrompt() is deliberately static and parameter-free. The Task 1
  // review rejected speculative `providerLabel` / `maxTurns` parameters — the
  // system prompt is generic ~400 tokens of discipline that applies to every
  // provider. Per-turn budget information is threaded through buildBudgetHint
  // (prepended to the first user prompt) and buildReGroundingMessage
  // (injected every RE_GROUNDING_INTERVAL_TURNS turns).
  const systemPrompt = buildSystemPrompt();
  const budgetHint = buildBudgetHint({ maxTurns });
  const promptWithBudgetHint = `${budgetHint}\n\n${prompt}`;

  const agent = new Agent({
    name: 'sub-agent',
    model,
    instructions: systemPrompt,
    tools,
    ...(effort && effort !== 'none' && {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modelSettings: { reasoning: { effort: effort as any } },
    }),
  });

  // --- Watchdog: resolve the input-token soft limit once per run ---
  const profile = findModelProfile(runner.providerConfig.model);
  const softLimit = resolveInputTokenSoftLimit(runner.providerConfig, profile);

  // --- Scratchpad: buffers assistant text across every agentRun() call so
  // that every termination path (ok/incomplete/max_turns/error/timeout/
  // force_salvage) can return the best text we heard, even if the final
  // message is junk. ---
  const scratchpad = new TextScratchpad();

  /**
   * Build an AgentInputItem[] for continuing `prev` with a new user message.
   *
   * @openai/agents does NOT expose a `conversation:` option on `run()`. It
   * accepts `string | AgentInputItem[] | RunState` as the input. The idiomatic
   * way to "continue" a completed run with a new user turn is to pass
   * `[...prev.history, { role: 'user', content: newText }]` as the input on
   * the next call. `result.history` is the full conversation (system prompt
   * + original input + every new item generated during the run), typed as
   * `AgentInputItem[]`. See node_modules/@openai/agents-core/dist/run.d.ts
   * line 182 and result.d.ts line 84 (history getter).
   */
  const continueWith = (
    prev: AgentRunOutput,
    nextUserMessage: string,
  ): AgentInputItem[] => {
    const history = prev.history;
    return [
      ...history,
      { role: 'user' as const, content: nextUserMessage },
    ];
  };

  const run = async (): Promise<RunResult> => {
    let currentResult: AgentRunOutput;
    try {
      currentResult = await agentRun(agent, promptWithBudgetHint, {
        maxTurns,
        signal: abortController.signal,
      });
      scratchpad.append(
        currentResult.state.usage.requests,
        stripThinkingTags(extractAssistantText(currentResult.newItems)),
      );

      let supervisionRetries = 0;
      let lastDegenerateOutput = '';

      // Supervision loop. On each iteration we:
      //   1. Check the watchdog (may force-terminate or nudge)
      //   2. Validate the final message (may re-prompt)
      //   3. Inject re-grounding every RE_GROUNDING_INTERVAL_TURNS turns
      // A single pass where validateCompletion returns `valid` is the clean
      // exit. Otherwise we either re-prompt (and loop) or salvage.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // --- Watchdog check ---
        const currentInputTokens = currentResult.state.usage.inputTokens;
        const watchdogStatus = checkWatchdogThreshold(currentInputTokens, softLimit);

        if (watchdogStatus !== 'ok') {
          logWatchdogEvent(watchdogStatus, {
            provider: 'openai-compatible',
            model: runner.providerConfig.model,
            turn: currentResult.state.usage.requests,
            inputTokens: currentInputTokens,
            softLimit,
            scratchpadChars: scratchpad.toString().length,
          });
        }

        if (watchdogStatus === 'force_salvage') {
          return buildForceSalvageResult(
            currentResult,
            scratchpad,
            tracker,
            runner.providerConfig,
            softLimit,
          );
        }

        if (watchdogStatus === 'warning') {
          const warning =
            `Budget pressure: you have used approximately ${currentInputTokens} ` +
            `input tokens out of a soft limit of ${softLimit}. Stop exploring and ` +
            `produce your complete final answer now with whatever you have gathered.`;
          currentResult = await agentRun(agent, continueWith(currentResult, warning), {
            maxTurns: 1,
            signal: abortController.signal,
          });
          scratchpad.append(
            currentResult.state.usage.requests,
            stripThinkingTags(extractAssistantText(currentResult.newItems)),
          );
          // Re-enter the loop head (re-check watchdog & validation).
          continue;
        }

        // --- Validation check ---
        const stripped = stripThinkingTags(currentResult.finalOutput ?? '');
        const validation = validateCompletion(stripped);

        if (validation.valid) {
          return buildOkResult(stripped, currentResult, tracker, runner.providerConfig);
        }

        // Degenerate. Apply same-output early-out and retry budget.
        if (sameDegenerateOutput(stripped, lastDegenerateOutput)) break;
        lastDegenerateOutput = stripped;
        supervisionRetries++;
        if (supervisionRetries >= MAX_SUPERVISION_RETRIES) break;

        // --- Re-prompt the model to recover ---
        const rePrompt = buildRePrompt(validation);
        currentResult = await agentRun(agent, continueWith(currentResult, rePrompt), {
          // Give the model a small budget to recover. One extra turn per
          // retry is enough for the "emit your final answer" nudge.
          maxTurns: 1,
          signal: abortController.signal,
        });
        scratchpad.append(
          currentResult.state.usage.requests,
          stripThinkingTags(extractAssistantText(currentResult.newItems)),
        );

        // --- Periodic re-grounding ---
        const turnsSoFar = currentResult.state.usage.requests;
        if (turnsSoFar > 0 && turnsSoFar % RE_GROUNDING_INTERVAL_TURNS === 0) {
          const reground = buildReGroundingMessage({
            originalPromptExcerpt: prompt,
            currentTurn: turnsSoFar,
            maxTurns,
            toolCallsSoFar: tracker.getToolCalls().length,
            filesReadSoFar: tracker.getReads().length,
          });
          currentResult = await agentRun(agent, continueWith(currentResult, reground), {
            maxTurns: 1,
            signal: abortController.signal,
          });
          scratchpad.append(
            currentResult.state.usage.requests,
            stripThinkingTags(extractAssistantText(currentResult.newItems)),
          );
        }
      }

      // Supervision exhausted (either retry budget or same-output early-out).
      // Salvage from the scratchpad if we have anything; otherwise return the
      // existing incomplete diagnostic.
      return buildSupervisionExhaustedResult(
        currentResult,
        scratchpad,
        tracker,
        runner.providerConfig,
      );
    } catch (err) {
      if (err instanceof MaxTurnsExceededError) {
        // max_turns path: prefer scratchpad salvage over the bare diagnostic.
        const filesRead = tracker.getReads();
        const filesWritten = tracker.getWrites();
        const toolCalls = tracker.getToolCalls();
        return {
          output: scratchpad.isEmpty()
            ? `Agent exceeded max turns (${maxTurns}).`
            : scratchpad.latest(),
          status: 'max_turns',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
          turns: maxTurns,
          filesRead,
          filesWritten,
          toolCalls,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        output: scratchpad.isEmpty() ? `Sub-agent error: ${msg}` : scratchpad.latest(),
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
        turns: 0,
        filesRead: tracker.getReads(),
        filesWritten: tracker.getWrites(),
        toolCalls: tracker.getToolCalls(),
        error: msg,
      };
    }
  };

  return withTimeout(
    run(),
    timeoutMs,
    () => ({
      output: scratchpad.isEmpty()
        ? `Agent timed out after ${timeoutMs}ms.`
        : scratchpad.latest(),
      status: 'timeout',
      filesRead: tracker.getReads(),
      filesWritten: tracker.getWrites(),
      toolCalls: tracker.getToolCalls(),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
      turns: maxTurns,
    }),
    abortController,
  );
}

// --- Helpers: canonical return-shape builders -------------------------------

function buildOkResult(
  output: string,
  currentResult: AgentRunOutput,
  tracker: FileTracker,
  providerConfig: ProviderConfig,
): RunResult {
  const usage = currentResult.state.usage;
  const costUSD = computeCostUSD(usage.inputTokens, usage.outputTokens, providerConfig);
  return {
    output,
    status: 'ok',
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costUSD,
    },
    turns: usage.requests,
    filesRead: tracker.getReads(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
  };
}

function buildSupervisionExhaustedResult(
  currentResult: AgentRunOutput,
  scratchpad: TextScratchpad,
  tracker: FileTracker,
  providerConfig: ProviderConfig,
): RunResult {
  const usage = currentResult.state.usage;
  const filesRead = tracker.getReads();
  const filesWritten = tracker.getWrites();
  const toolCalls = tracker.getToolCalls();
  const costUSD = computeCostUSD(usage.inputTokens, usage.outputTokens, providerConfig);
  return {
    output: scratchpad.isEmpty()
      ? buildIncompleteDiagnostic({
          providerLabel: 'openai-compatible',
          turns: usage.requests,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          filesRead,
          filesWritten,
        })
      : scratchpad.latest(),
    status: 'incomplete',
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costUSD,
    },
    turns: usage.requests,
    filesRead,
    filesWritten,
    toolCalls,
  };
}

function buildForceSalvageResult(
  currentResult: AgentRunOutput,
  scratchpad: TextScratchpad,
  tracker: FileTracker,
  providerConfig: ProviderConfig,
  softLimit: number,
): RunResult {
  const usage = currentResult.state.usage;
  const filesRead = tracker.getReads();
  const filesWritten = tracker.getWrites();
  const toolCalls = tracker.getToolCalls();
  const costUSD = computeCostUSD(usage.inputTokens, usage.outputTokens, providerConfig);
  return {
    output: scratchpad.isEmpty()
      ? `[openai-compatible sub-agent forcibly terminated at ${usage.inputTokens} input tokens (soft limit ${softLimit}). No usable text was buffered.]`
      : scratchpad.latest(),
    status: 'incomplete',
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costUSD,
    },
    turns: usage.requests,
    filesRead,
    filesWritten,
    toolCalls,
  };
}

/**
 * Synthesise a diagnostic message for runs that completed without producing
 * usable final output. Surfaces enough metadata for the caller to debug:
 * how many turns were spent, what the model burnt token-wise, and what files
 * the worker actually looked at before giving up.
 */
function buildIncompleteDiagnostic(opts: {
  providerLabel: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  filesRead: string[];
  filesWritten: string[];
}): string {
  const lines = [
    `[${opts.providerLabel} sub-agent terminated without producing a final answer]`,
    '',
    'The agent loop ended on a message with no tool calls and no plain-text content. ' +
      'This usually means one of:',
    '  • the model emitted only <think> reasoning, then stopped',
    '  • the model produced a conversational fragment instead of a final answer',
    '  • a tool call was malformed and the SDK treated the response as terminal',
    '',
    `Turns used:    ${opts.turns}`,
    `Input tokens:  ${opts.inputTokens}`,
    `Output tokens: ${opts.outputTokens}`,
    `Files read:    ${opts.filesRead.length}${opts.filesRead.length > 0 ? ` (${formatFileList(opts.filesRead)})` : ''}`,
    `Files written: ${opts.filesWritten.length}${opts.filesWritten.length > 0 ? ` (${formatFileList(opts.filesWritten)})` : ''}`,
    '',
    'Recommended action: re-dispatch with a tighter, more explicit brief, or escalate to a higher-tier provider.',
  ];
  return lines.join('\n');
}

function formatFileList(files: string[]): string {
  const MAX_SHOWN = 10;
  if (files.length <= MAX_SHOWN) return files.join(', ');
  return `${files.slice(0, MAX_SHOWN).join(', ')}, … ${files.length - MAX_SHOWN} more`;
}
