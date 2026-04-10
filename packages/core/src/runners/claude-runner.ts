import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { withTimeout, computeCostUSD, type RunResult, type RunOptions, type ProviderConfig } from '../types.js';
import { FileTracker } from '../tools/tracker.js';
import { createToolImplementations } from '../tools/definitions.js';
import { createClaudeToolServer } from '../tools/claude-adapter.js';
import { TextScratchpad } from '../tools/scratchpad.js';
import {
  buildSystemPrompt,
  buildBudgetHint,
  buildReGroundingMessage,
  buildBudgetPressureNudge,
  RE_GROUNDING_INTERVAL_TURNS,
} from './prevention.js';
import {
  validateCompletion,
  buildRePrompt,
  sameDegenerateOutput,
  resolveInputTokenSoftLimit,
  checkWatchdogThreshold,
  logWatchdogEvent,
} from './supervision.js';
import { classifyError } from './error-classification.js';
import { findModelProfile } from '../routing/model-profiles.js';

/**
 * Hard cap on supervision re-prompts before we give up and salvage. Same as
 * openai-runner; see spec A.2.2.
 */
const MAX_SUPERVISION_RETRIES = 3;

/**
 * Minimal pushable async-iterable queue for feeding user messages to the
 * claude-agent-sdk `query()` in streaming-input mode.
 *
 * The SDK's `query({ prompt: string | AsyncIterable<SDKUserMessage>, ... })`
 * signature (see node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts L1879-1882)
 * accepts an async iterable when we want multi-turn input — the intended
 * pathway for "push a follow-up user message into the current query without
 * restarting the CLI subprocess." The built-in `streamInput(...)` method on
 * the returned `Query` object (sdk.d.ts L1862) is documented as "used
 * internally for multi-turn conversations", and the only public way to
 * drive multi-turn input is via this iterable.
 *
 * This class is deliberately small: `push(msg)` delivers a message to a
 * waiting iterator (or buffers it if the iterator isn't waiting yet),
 * `close()` signals end-of-stream, and `[Symbol.asyncIterator]()` returns
 * a generator that yields buffered messages then awaits the next push.
 */
class PushableUserMessageQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private resolvers: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
        }
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

/**
 * Wrap a plain string in the SDKUserMessage envelope the SDK expects when
 * using streaming input mode. Keeps the per-call sites tidy.
 */
function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

export async function runClaude(
  prompt: string,
  options: RunOptions,
  providerConfig: ProviderConfig,
  defaults: { maxTurns: number; timeoutMs: number; tools: 'none' | 'full' },
): Promise<RunResult> {
  const maxTurns = options.maxTurns ?? providerConfig.maxTurns ?? defaults.maxTurns;
  const timeoutMs = options.timeoutMs ?? providerConfig.timeoutMs ?? defaults.timeoutMs;
  const toolMode = options.tools ?? defaults.tools;
  const cwd = options.cwd ?? process.cwd();
  const effort = options.effort ?? providerConfig.effort;

  const sandboxPolicy = options.sandboxPolicy ?? providerConfig.sandboxPolicy ?? 'cwd-only';
  const abortController = new AbortController();

  const tracker = new FileTracker();
  const toolImpls = createToolImplementations(tracker, cwd, sandboxPolicy, abortController.signal);

  // --- Prevention layer: system prompt + budget hint ---
  //
  // buildSystemPrompt() is deliberately static and parameter-free (same
  // decision as openai-runner: Task 1 review rejected provider/maxTurns
  // options). We append our discipline rules onto the `claude_code` preset
  // rather than REPLACING the default system prompt, because replacing it
  // strips the SDK's tool-usage guidance. See
  // node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts L1460-1465 for the
  // systemPrompt union type — `{ type: 'preset', preset: 'claude_code',
  // append: string }` is the intended "add to defaults" shape.
  const systemPrompt = buildSystemPrompt();
  const budgetHint = buildBudgetHint({ maxTurns });
  const promptWithBudgetHint = `${budgetHint}\n\n${prompt}`;

  // Permission bypass is intentional for sub-agent use. File-system confinement
  // is enforced by assertWithinCwd in tool definitions when sandboxPolicy is 'cwd-only'.
  const queryOptions: Options = {
    model: providerConfig.model,
    maxTurns,
    cwd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    abortController,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: systemPrompt,
    },
  };

  if (toolMode === 'full') {
    const toolServer = createClaudeToolServer(toolImpls, sandboxPolicy);
    queryOptions.mcpServers = { 'code-tools': toolServer };
    // Enable Claude's built-in WebSearch and WebFetch alongside our MCP code
    // tool server, so the capabilities matrix's claim that claude has
    // web_search + web_fetch is actually true at runtime. Shell is NOT in
    // this list — it stays behind the sandboxPolicy gate via our code-tools
    // MCP server's runShell implementation.
    queryOptions.tools = ['WebSearch', 'WebFetch'];
    queryOptions.allowedTools = ['mcp__code-tools__*', 'WebSearch', 'WebFetch'];
  } else {
    queryOptions.tools = [];
  }

  if (!effort || effort === 'none') {
    queryOptions.thinking = { type: 'disabled' };
  } else {
    queryOptions.thinking = { type: 'adaptive' };
    // effort is typed as EffortLevel in Options; cast from string
    queryOptions.effort = effort as Options['effort'];
  }

  // Hoisted so the timeout callback can read partial progress
  let inputTokens = 0;
  let outputTokens = 0;
  let costUSD: number | null = null;
  let turns = 0;

  // --- Scratchpad: buffers every assistant text block we see streaming
  // through the iterator. On any termination path (ok/incomplete/max_turns/
  // error/timeout/force_salvage) we salvage `scratchpad.latest()` when the
  // final `result.result` is empty or degenerate. ---
  const scratchpad = new TextScratchpad();

  // --- Watchdog: resolve the input-token soft limit once per run ---
  const profile = findModelProfile(providerConfig.model);
  const softLimit = resolveInputTokenSoftLimit(providerConfig, profile);

  const run = async (): Promise<RunResult> => {
    let output = '';

    // --- Supervision / watchdog bookkeeping ---
    let supervisionRetries = 0;
    // Initialised to `null` (NOT ''): on the first turn there is no
    // previous degenerate output to compare against, so the same-output
    // early-out must be skipped. See openai-runner regression #5.
    let lastDegenerateOutput: string | null = null;
    // High-watermark guard for the watchdog warning nudge — fire at most
    // once per distinct input-token level. Mirrors openai-runner.
    let lastWarnedInputTokens = -1;

    // --- Completed-result sentinel. Every exit from the supervision
    // state machine inside the `for await` iterator sets this to a fully-
    // built RunResult and then `break`s. After the loop, the one explicit
    // return on the happy path is `completedResult`. This gives every
    // exit (ok / incomplete / force_salvage / max_turns) a single
    // explicit owner, mirroring openai-runner's `while (true) + return`
    // shape but compatible with the for-await iterator contract. ---
    let completedResult: RunResult | null = null;

    // --- Streaming input queue. See PushableUserMessageQueue docstring:
    // using an async iterable as the `prompt` enables mid-run user-message
    // injection (supervision re-prompts, re-grounding, budget-pressure
    // nudges) without restarting the CLI subprocess. ---
    const messageQueue = new PushableUserMessageQueue();
    messageQueue.push(userMessage(promptWithBudgetHint));

    try {
      for await (const msg of query({ prompt: messageQueue, options: queryOptions })) {
        if (msg.type === 'assistant') {
          turns++;

          // Capture every assistant text block as scratchpad fodder. The
          // claude-agent-sdk's BetaMessage.content is an array of blocks:
          // `{ type: 'text', text } | { type: 'tool_use', ... } |
          // { type: 'thinking', ... } | ...`. We only want plain text;
          // tool_use blocks have no salvage value (they're side-effects)
          // and thinking blocks are stripped before the caller sees them.
          if ('message' in msg && msg.message && 'content' in msg.message) {
            const content = msg.message.content;
            if (typeof content === 'string') {
              scratchpad.append(turns, content);
            } else if (Array.isArray(content)) {
              const texts = content
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .map((c: any) => c.text);
              if (texts.length > 0) {
                scratchpad.append(turns, texts.join('\n'));
              }
            }
          }

          // --- Watchdog check (assistant-message cadence). We check
          // `inputTokens` as accumulated from prior `result` messages.
          // On the very first assistant message inputTokens is 0 and no
          // threshold can fire; that's correct. This is also the ONLY
          // site that handles `warning` — it logs AND pushes the nudge
          // as one action. The post-result site only handles
          // force_salvage. ---
          const watchdogStatus = checkWatchdogThreshold(inputTokens, softLimit);
          if (watchdogStatus !== 'ok') {
            logWatchdogEvent(watchdogStatus, {
              provider: 'claude',
              model: providerConfig.model,
              turn: turns,
              inputTokens,
              softLimit,
              scratchpadChars: scratchpad.toString().length,
            });
          }
          if (watchdogStatus === 'force_salvage') {
            completedResult = buildClaudeForceSalvageResult({
              tracker,
              scratchpad,
              providerConfig,
              sdkCostUSD: costUSD,
              inputTokens,
              outputTokens,
              turns,
              softLimit,
            });
            messageQueue.close();
            abortController.abort();
            break;
          }
          // Fire the warning nudge at most once per distinct input-token
          // high-watermark. We push a user message into the queue so the
          // next turn of the conversation will address the budget-pressure
          // prompt. If the nudge response is itself a valid final answer,
          // the supervision loop on the NEXT `result` message will return
          // `ok`. High-watermark guard prevents re-nudging if inputTokens
          // stays the same across two assistant messages.
          if (watchdogStatus === 'warning' && inputTokens > lastWarnedInputTokens) {
            lastWarnedInputTokens = inputTokens;
            messageQueue.push(
              userMessage(buildBudgetPressureNudge({ inputTokens, softLimit })),
            );
          }

          // --- Periodic re-grounding (best-effort in streaming-input
          // mode): inject a reminder every RE_GROUNDING_INTERVAL_TURNS
          // turns via the same queue. The iterator keeps reading until
          // the CLI subprocess decides to emit a final result after it
          // processes the new user message. ---
          if (turns > 0 && turns % RE_GROUNDING_INTERVAL_TURNS === 0) {
            messageQueue.push(
              userMessage(
                buildReGroundingMessage({
                  originalPromptExcerpt: prompt,
                  currentTurn: turns,
                  maxTurns,
                  toolCallsSoFar: tracker.getToolCalls().length,
                  filesReadSoFar: tracker.getReads().length,
                }),
              ),
            );
          }
        }

        if (msg.type === 'result') {
          if ('result' in msg) {
            output = msg.result;
          }

          const hitMaxTurns = 'subtype' in msg && msg.subtype === 'error_max_turns';

          // Extract usage from modelUsage or usage, then ACCUMULATE into
          // the running inputTokens/outputTokens. Supervision retries in
          // streaming-input mode push a new user message into the queue
          // and the SDK emits a fresh `result` message per top-level user
          // turn — we want the cumulative usage across every result we
          // see, not just the last one. Accumulation keeps the watchdog
          // soft-limit check honest across retries and produces correct
          // totals on any termination path.
          let turnInputTokens = 0;
          let turnOutputTokens = 0;
          if ('modelUsage' in msg && msg.modelUsage) {
            for (const model of Object.values(msg.modelUsage)) {
              turnInputTokens += model.inputTokens ?? 0;
              turnOutputTokens += model.outputTokens ?? 0;
            }
          } else if ('usage' in msg && msg.usage) {
            const u = msg.usage as unknown as Record<string, number>;
            turnInputTokens = u['input_tokens'] ?? 0;
            turnOutputTokens = u['output_tokens'] ?? 0;
          }
          inputTokens += turnInputTokens;
          outputTokens += turnOutputTokens;

          if ('total_cost_usd' in msg && typeof msg.total_cost_usd === 'number') {
            costUSD = msg.total_cost_usd;
          }

          // --- Watchdog check on the result message as well: input tokens
          // have just jumped and we may now be in force_salvage territory.
          // The post-result site ONLY handles force_salvage. `warning` is
          // intentionally ignored here — the assistant-message-cadence site
          // above is the single place that logs warnings AND pushes the
          // nudge into the queue. Logging `warning` here without pushing a
          // nudge would be misleading (suggests action that didn't happen).
          const postResultWatchdog = checkWatchdogThreshold(inputTokens, softLimit);
          if (postResultWatchdog === 'force_salvage') {
            logWatchdogEvent(postResultWatchdog, {
              provider: 'claude',
              model: providerConfig.model,
              turn: turns,
              inputTokens,
              softLimit,
              scratchpadChars: scratchpad.toString().length,
            });
            completedResult = buildClaudeForceSalvageResult({
              tracker,
              scratchpad,
              providerConfig,
              sdkCostUSD: costUSD,
              inputTokens,
              outputTokens,
              turns,
              softLimit,
            });
            messageQueue.close();
            abortController.abort();
            break;
          }

          // --- Max-turns: don't supervise a max-turns termination,
          // build the max_turns result directly and exit. ---
          if (hitMaxTurns) {
            completedResult = buildClaudeMaxTurnsResult({
              tracker,
              scratchpad,
              providerConfig,
              sdkCostUSD: costUSD,
              inputTokens,
              outputTokens,
              turns,
              maxTurns,
              lastOutput: output,
            });
            messageQueue.close();
            break;
          }

          // --- Supervision: validate the captured output. Valid output
          // is an immediate ok-exit. Degenerate output either re-prompts
          // (and keeps reading the iterator) or — if the retry budget is
          // spent / same-output early-out fires — exits as incomplete. ---
          const validation = validateCompletion(output);
          if (validation.valid) {
            completedResult = buildClaudeOkResult({
              tracker,
              scratchpad,
              providerConfig,
              sdkCostUSD: costUSD,
              inputTokens,
              outputTokens,
              turns,
              output,
            });
            messageQueue.close();
            break;
          }

          // Same-output early-out: don't burn another retry on identical
          // garbage. Compare only when we have a previous degenerate.
          if (
            lastDegenerateOutput !== null &&
            sameDegenerateOutput(output, lastDegenerateOutput)
          ) {
            completedResult = buildClaudeIncompleteResult({
              tracker,
              scratchpad,
              providerConfig,
              sdkCostUSD: costUSD,
              inputTokens,
              outputTokens,
              turns,
            });
            messageQueue.close();
            break;
          }
          lastDegenerateOutput = output;
          supervisionRetries++;
          if (supervisionRetries >= MAX_SUPERVISION_RETRIES) {
            completedResult = buildClaudeIncompleteResult({
              tracker,
              scratchpad,
              providerConfig,
              sdkCostUSD: costUSD,
              inputTokens,
              outputTokens,
              turns,
            });
            messageQueue.close();
            break;
          }

          // Push the re-prompt and continue reading the iterator.
          messageQueue.push(userMessage(buildRePrompt(validation)));
        }
      }
    } catch (err) {
      // Preserve partial usage — the scratchpad may have buffered text
      // from turns that ran before the throw. Route the thrown error
      // through the shared classifier so the escalation orchestrator can
      // distinguish abort / network / HTTP-error / generic failure modes.
      const { status, reason } = classifyError(err);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        output: scratchpad.isEmpty()
          ? `Sub-agent error: ${msg}`
          : scratchpad.latest(),
        status,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          costUSD: effectiveClaudeCost(providerConfig, inputTokens, outputTokens, costUSD),
        },
        turns,
        filesRead: tracker.getReads(),
        filesWritten: tracker.getWrites(),
        toolCalls: tracker.getToolCalls(),
        escalationLog: [],
        error: msg || reason,
      };
    }

    // Every `break` inside the iterator above assigned `completedResult`
    // before exiting. If the iterator drained without any break (e.g. the
    // SDK closed the stream cleanly without ever emitting a final
    // `result`), synthesize an incomplete result so the caller always
    // gets a meaningful diagnostic instead of undefined.
    if (completedResult) return completedResult;
    return buildClaudeIncompleteResult({
      tracker,
      scratchpad,
      providerConfig,
      sdkCostUSD: costUSD,
      inputTokens,
      outputTokens,
      turns,
    });
  };

  return withTimeout(
    run(),
    timeoutMs,
    () => ({
      output: scratchpad.isEmpty() ? `Agent timed out after ${timeoutMs}ms.` : scratchpad.latest(),
      status: 'timeout',
      filesRead: tracker.getReads(),
      filesWritten: tracker.getWrites(),
      toolCalls: tracker.getToolCalls(),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUSD: effectiveClaudeCost(providerConfig, inputTokens, outputTokens, costUSD),
      },
      turns,
      escalationLog: [],
    }),
    abortController,
  );
}

// --- Helpers: canonical return-shape builders -------------------------------
//
// Mirror openai-runner's buildOkResult / buildSupervisionExhaustedResult /
// buildForceSalvageResult so each exit from the supervision state machine is
// a one-line call. Every helper folds the shared
// filesRead/filesWritten/toolCalls/effectiveCost preamble so the call sites
// in run() stay short and symmetric across runners.

interface ClaudeResultCommonArgs {
  tracker: FileTracker;
  scratchpad: TextScratchpad;
  providerConfig: ProviderConfig;
  sdkCostUSD: number | null;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

function effectiveClaudeCost(
  providerConfig: ProviderConfig,
  inputTokens: number,
  outputTokens: number,
  sdkCost: number | null,
): number | null {
  const computed = computeCostUSD(inputTokens, outputTokens, providerConfig);
  return computed ?? sdkCost;
}

function buildClaudeOkResult(
  args: ClaudeResultCommonArgs & { output: string },
): RunResult {
  const { tracker, providerConfig, sdkCostUSD, inputTokens, outputTokens, turns, output } = args;
  return {
    output,
    status: 'ok',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUSD: effectiveClaudeCost(providerConfig, inputTokens, outputTokens, sdkCostUSD),
    },
    turns,
    filesRead: tracker.getReads(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
    escalationLog: [],
  };
}

/**
 * Supervision-exhausted path: retry cap hit or same-output early-out. Prefer
 * scratchpad salvage; fall back to the incomplete diagnostic.
 */
function buildClaudeIncompleteResult(
  args: ClaudeResultCommonArgs,
): RunResult {
  const { tracker, scratchpad, providerConfig, sdkCostUSD, inputTokens, outputTokens, turns } = args;
  const filesRead = tracker.getReads();
  const filesWritten = tracker.getWrites();
  return {
    output: scratchpad.isEmpty()
      ? buildClaudeIncompleteDiagnostic({
          turns,
          inputTokens,
          outputTokens,
          filesRead,
          filesWritten,
        })
      : scratchpad.latest(),
    status: 'incomplete',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUSD: effectiveClaudeCost(providerConfig, inputTokens, outputTokens, sdkCostUSD),
    },
    turns,
    filesRead,
    filesWritten,
    toolCalls: tracker.getToolCalls(),
    escalationLog: [],
  };
}

function buildClaudeForceSalvageResult(
  args: ClaudeResultCommonArgs & { softLimit: number },
): RunResult {
  const { tracker, scratchpad, providerConfig, sdkCostUSD, inputTokens, outputTokens, turns, softLimit } = args;
  return {
    output: scratchpad.isEmpty()
      ? `[claude sub-agent forcibly terminated at ${inputTokens} input tokens (soft limit ${softLimit}). No usable text was buffered.]`
      : scratchpad.latest(),
    status: 'incomplete',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUSD: effectiveClaudeCost(providerConfig, inputTokens, outputTokens, sdkCostUSD),
    },
    turns,
    filesRead: tracker.getReads(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
    escalationLog: [],
  };
}

function buildClaudeMaxTurnsResult(
  args: ClaudeResultCommonArgs & { maxTurns: number; lastOutput: string },
): RunResult {
  const { tracker, scratchpad, providerConfig, sdkCostUSD, inputTokens, outputTokens, turns, maxTurns, lastOutput } = args;
  return {
    output: scratchpad.isEmpty()
      ? lastOutput || `Agent exceeded max turns (${maxTurns}).`
      : scratchpad.latest(),
    status: 'max_turns',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUSD: effectiveClaudeCost(providerConfig, inputTokens, outputTokens, sdkCostUSD),
    },
    turns,
    filesRead: tracker.getReads(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
    escalationLog: [],
  };
}

function buildClaudeIncompleteDiagnostic(opts: {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  filesRead: string[];
  filesWritten: string[];
}): string {
  const formatList = (files: string[]) => {
    const MAX_SHOWN = 10;
    if (files.length === 0) return '';
    if (files.length <= MAX_SHOWN) return ` (${files.join(', ')})`;
    return ` (${files.slice(0, MAX_SHOWN).join(', ')}, … ${files.length - MAX_SHOWN} more)`;
  };
  return [
    '[claude sub-agent terminated without producing a final answer]',
    '',
    'The query stream ended without ever emitting a result message. This usually means ' +
      'the agent loop exited prematurely or the SDK lost the final message.',
    '',
    `Turns used:    ${opts.turns}`,
    `Input tokens:  ${opts.inputTokens}`,
    `Output tokens: ${opts.outputTokens}`,
    `Files read:    ${opts.filesRead.length}${formatList(opts.filesRead)}`,
    `Files written: ${opts.filesWritten.length}${formatList(opts.filesWritten)}`,
    '',
    'Recommended action: re-dispatch with a tighter brief, or check Claude Agent SDK logs.',
  ].join('\n');
}
