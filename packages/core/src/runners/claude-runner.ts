import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createHash } from 'node:crypto';
import {
  withTimeout,
  computeCostUSD,
  computeSavedCostUSD,
  type RunResult,
  type RunOptions,
  type ProviderConfig,
  type ProgressEvent,
  type ToolMode,
} from '../types.js';
import { FileTracker } from '../tools/tracker.js';
import { createToolImplementations } from '../tools/definitions.js';
import { createClaudeToolServer } from '../tools/claude-adapter.js';
import { TextScratchpad } from '../tools/scratchpad.js';
import { CostMeter } from '../cost/cost-meter.js';
import { CallCache } from '../tools/call-cache.js';
import {
  buildSystemPrompt,
  buildBudgetHint,
  buildReGroundingMessage,
  buildBudgetPressureNudge,
  buildFormatConstraintSuffix,
  RE_GROUNDING_INTERVAL_TURNS,
} from './prevention.js';
import {
  validateSubAgentOutput,
  buildRePrompt,
  sameDegenerateOutput,
  resolveInputTokenSoftLimit,
  checkWatchdogThreshold,
  logWatchdogEvent,
  hasCompletedWork,
  MAX_DEGENERATE_RETRIES,
  STALL_DETECTION_TURNS,
  detectToolCallLoop,
  hasNewFileActivity,
} from './supervision.js';
import { injectionTypeFor } from './injection-type.js';
import { classifyError } from './error-classification.js';
import { findModelProfile } from '../routing/model-profiles.js';



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
  defaults: { timeoutMs: number; tools: ToolMode },
): Promise<RunResult> {
  const maxTurns = options.maxTurns ?? providerConfig.maxTurns ?? Number.MAX_SAFE_INTEGER;
  const timeoutMs = options.timeoutMs ?? providerConfig.timeoutMs ?? defaults.timeoutMs;
  const toolMode = options.tools ?? defaults.tools;
  const cwd = options.cwd ?? process.cwd();
  const effort = options.effort ?? providerConfig.effort;

  const sandboxPolicy = options.sandboxPolicy ?? providerConfig.sandboxPolicy ?? 'cwd-only';
  const abortController = new AbortController();

  // --- Progress event emission (Task 10) ----------------------------------
  //
  // `onProgress` is already wrapped in `safeSink` by the orchestrator
  // (Task 8), so any throw from the consumer callback is swallowed
  // upstream and cannot corrupt this loop. We do not need to wrap it
  // again here.
  const onProgress = options.onProgress;
  const emit = (event: ProgressEvent): void => {
    if (onProgress) onProgress(event);
  };

  // Hoisted so the FileTracker callback (closed over below) can read the
  // running turn count at callback firing time. Unlike openai-runner — where
  // the turn counter comes from `currentResult?.state.usage.requests + 1`
  // because the SDK only bumps the counter after the call completes — the
  // claude-runner increments `turns` at the top of every `msg.type ===
  // 'assistant'` branch, which is PROCESSED BEFORE the SDK fires any tool
  // calls for that turn. That means `turns` already holds the current
  // turn number when the tracker callback fires mid-tool-loop, so we
  // attribute tool calls to `turns` directly (no +1 offset).
  let inputTokens = 0;
  let outputTokens = 0;
  let costUSD: number | null = null;
  let turns = 0;

  const tracker = new FileTracker((summary) => {
    emit({ kind: 'tool_call', turn: turns, toolSummary: summary });
  });
  const toolImpls = createToolImplementations(tracker, cwd, sandboxPolicy, abortController.signal);

  // --- Cost meter (Task 25) ------------------------------------------------
  const costMeter = new CostMeter({ ceiling: options.maxCostUSD });

  // --- Call cache (Task 25) ------------------------------------------------
  const callCache = new CallCache();
  const agentType = providerConfig.type ?? 'claude';

  // Track last turn cost for estimating next turn cost
  let lastTurnCostUSD = 0;

  /**
   * Check if we can afford the next turn based on previous turn cost estimate.
   */
  function canAffordNextTurn(): boolean {
    if (!costMeter.canProceed(lastTurnCostUSD > 0 ? lastTurnCostUSD : 0.001)) {
      return false;
    }
    return true;
  }

  /**
   * Build a cost_exceeded result.
   */
  function buildCostExceededResult(): RunResult {
    const finalCostUSD = effectiveClaudeCost(providerConfig, inputTokens, outputTokens, costUSD);
    const savedCostUSD = computeSavedCostUSD(finalCostUSD, inputTokens, outputTokens, parentModel);
    return {
      output: `Cost ceiling exceeded: maxCostUSD=${options.maxCostUSD}`,
      status: 'cost_exceeded',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUSD: finalCostUSD,
        savedCostUSD,
      },
      turns,
      filesRead: tracker.getReads(),
      directoriesListed: tracker.getDirectoriesListed(),
      filesWritten: tracker.getWrites(),
      toolCalls: tracker.getToolCalls(),
      outputIsDiagnostic: true,
      escalationLog: [],
      durationMs: Date.now() - taskStartMs,
    };
  }

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
  const systemPrompt = buildSystemPrompt() + buildFormatConstraintSuffix(options.formatConstraints ?? {});
  const budgetHint = buildBudgetHint({ timeoutMs, maxCostUSD: options.maxCostUSD });
  const promptWithBudgetHint = `${budgetHint}\n\n${prompt}`;

  // --- onInitialRequest (Task 12) ----------------------------------------
  //
  // Fire once per attempt with the canonical orchestrator-side initial
  // brief: `${systemPrompt}\n\n${promptWithBudgetHint}`. This is NOT the
  // literal bytes the Anthropic SDK will send — the SDK wraps our
  // systemPrompt in `{ type: 'preset', preset: 'claude_code', append: ... }`
  // (see queryOptions.systemPrompt below), so the wire-level system prompt
  // includes the claude_code preset bytes that precede ours. We hash the
  // canonical form anyway for two reasons:
  //   1. It matches openai-runner and codex-runner, which also don't hash
  //      literal wire bytes (they hash the same canonical form before the
  //      SDK wraps it in its own `messages` / Responses API structures).
  //      Cross-runner stability is the Task 12 design requirement.
  //   2. It answers the "did the orchestrator send the same brief across
  //      retries?" question, which is the actual debugging use case — NOT
  //      "were the literal wire bytes identical?".
  // See `AttemptRecord.initialPromptHash` in types.ts for the full caveat.
  if (options.onInitialRequest) {
    const canonicalInitialBrief = `${systemPrompt}\n\n${promptWithBudgetHint}`;
    try {
      options.onInitialRequest({
        lengthChars: canonicalInitialBrief.length,
        sha256: createHash('sha256').update(canonicalInitialBrief).digest('hex'),
      });
    } catch {
      // Swallow — a broken callback must not affect dispatch.
    }
  }

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

  if (toolMode !== 'none') {
    const toolServer = createClaudeToolServer(toolImpls, sandboxPolicy, toolMode);
    if (toolServer) {
      queryOptions.mcpServers = { 'code-tools': toolServer };
    }
    // Enable Claude's built-in WebSearch and WebFetch alongside our MCP code
    // tool server, so the capabilities matrix's claim that claude has
    // web_search + web_fetch is actually true at runtime. Shell is NOT in
    // this list — it stays behind the sandboxPolicy gate via our code-tools
    // MCP server's runShell implementation.
    queryOptions.tools = ['WebSearch', 'WebFetch'];
    queryOptions.allowedTools = [
      ...(toolServer ? ['mcp__code-tools__*'] : []),
      'WebSearch', 'WebFetch',
    ];
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

  // --- Scratchpad: buffers every assistant text block we see streaming
  // through the iterator. On any termination path (ok/incomplete/max_turns/
  // error/timeout/force_salvage) we salvage `scratchpad.latest()` when the
  // final `result.result` is empty or degenerate. ---
  const scratchpad = new TextScratchpad();

  // --- Watchdog: resolve the input-token soft limit once per run ---
  const profile = findModelProfile(providerConfig.model);
  const softLimit = resolveInputTokenSoftLimit(providerConfig, profile);

  // --- Task timing + parent model (Task 9) --------------------------------
  const taskStartMs = Date.now();
  const parentModel = options.parentModel;

  const run = async (): Promise<RunResult> => {
    let output = '';

    // --- Supervision / watchdog bookkeeping ---
    // Monitor model: only count degenerate retries when worker has NO tool calls.
    let degenerateRetries = 0;
    let stallTurnCounter = 0;
    let lastFilesRead = tracker.getReads().length;
    let lastFilesWritten = tracker.getWrites().length;
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
          emit({ kind: 'turn_start', turn: turns, provider: 'claude' });

          // Capture every assistant text block as scratchpad fodder. The
          // claude-agent-sdk's BetaMessage.content is an array of blocks:
          // `{ type: 'text', text } | { type: 'tool_use', ... } |
          // { type: 'thinking', ... } | ...`. We only want plain text;
          // tool_use blocks have no salvage value (they're side-effects)
          // and thinking blocks are stripped before the caller sees them.
          if ('message' in msg && msg.message && 'content' in msg.message) {
            // The claude-agent-sdk's BetaMessage.content is typed as an
            // array of content blocks — but historically the API sometimes
            // delivers a bare string, so we defensively handle both. The
            // string branch is narrow-typed to `never` by the SDK, so we
            // cast through `unknown` to keep runtime safety without fighting
            // the compiler.
            const content = msg.message.content as unknown;
            if (typeof content === 'string') {
              scratchpad.append(turns, content);
              if (content.length > 0) {
                emit({
                  kind: 'text_emission',
                  turn: turns,
                  chars: content.length,
                  preview: content.slice(0, 200),
                });
              }
            } else if (Array.isArray(content)) {
              const texts = content
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .map((c: any) => c.text);
              if (texts.length > 0) {
                const joined = texts.join('\n');
                scratchpad.append(turns, joined);
                if (joined.length > 0) {
                  emit({
                    kind: 'text_emission',
                    turn: turns,
                    chars: joined.length,
                    preview: joined.slice(0, 200),
                  });
                }
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
            // `watchdog_force_salvage` is not an injected message — no
            // re-prompt is sent — but observers still want to see why the
            // run is being killed. We emit the event with
            // `contentLengthChars: 0` to reflect the "nothing was injected,
            // we just terminated" semantics (mirrors openai-runner).
            emit({
              kind: 'injection',
              injectionType: 'watchdog_force_salvage',
              turn: turns,
              contentLengthChars: 0,
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
              durationMs: Date.now() - taskStartMs,
              parentModel,
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
            const warning = buildBudgetPressureNudge({ inputTokens, softLimit });
            emit({
              kind: 'injection',
              injectionType: 'watchdog_warning',
              turn: turns,
              contentLengthChars: warning.length,
            });
            messageQueue.push(userMessage(warning));
          }

          // --- Periodic re-grounding (best-effort in streaming-input
          // mode): inject a reminder every RE_GROUNDING_INTERVAL_TURNS
          // turns via the same queue. The iterator keeps reading until
          // the CLI subprocess decides to emit a final result after it
          // processes the new user message. ---
          if (turns > 0 && turns % RE_GROUNDING_INTERVAL_TURNS === 0) {
            if (!canAffordNextTurn()) {
              completedResult = buildCostExceededResult();
              messageQueue.close();
              break;
            }
            const reground = buildReGroundingMessage({
              originalPromptExcerpt: prompt,
              elapsedMs: Date.now() - taskStartMs,
              timeoutMs,
              toolCallsSoFar: tracker.getToolCalls().length,
              filesReadSoFar: tracker.getReads().length,
            });
            emit({
              kind: 'injection',
              injectionType: 'reground',
              turn: turns,
              contentLengthChars: reground.length,
            });
            messageQueue.push(userMessage(reground));
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

          // --- turn_complete: one event per result message (which
          // corresponds to one top-level assistant turn from the SDK's
          // perspective). Fires after usage aggregation so the cumulative
          // counters are up-to-date.
          emit({
            kind: 'turn_complete',
            turn: turns,
            cumulativeInputTokens: inputTokens,
            cumulativeOutputTokens: outputTokens,
          });

          // Track cost for this turn (Task 25)
          const turnCost = computeCostUSD(turnInputTokens, turnOutputTokens, providerConfig);
          if (turnCost !== null) {
            lastTurnCostUSD = turnCost;
            costMeter.add(turnCost);
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
            emit({
              kind: 'injection',
              injectionType: 'watchdog_force_salvage',
              turn: turns,
              contentLengthChars: 0,
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
              durationMs: Date.now() - taskStartMs,
              parentModel,
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
              reason: `claude-agent-sdk signaled error_max_turns after ${turns} turns (user-declared maxTurns: ${maxTurns})`,
              durationMs: Date.now() - taskStartMs,
              parentModel,
            });
            messageQueue.close();
            break;
          }

          // --- Supervision: validate the captured output. Valid output
          // is an immediate ok-exit. Degenerate output either re-prompts
          // (and keeps reading the iterator) or — if the retry budget is
          // spent / same-output early-out fires — exits as incomplete. ---
          const validation = validateSubAgentOutput(output, {
            expectedCoverage: options.expectedCoverage,
            skipCompletionHeuristic: options.skipCompletionHeuristic,
            hasCompletedWork: hasCompletedWork(tracker.getToolCalls()),
          });

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
              durationMs: Date.now() - taskStartMs,
              parentModel,
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
              reason: `supervision loop exhausted after ${degenerateRetries} degenerate retries without tool calls (last kind: ${validation.kind ?? 'unknown'})`,
              durationMs: Date.now() - taskStartMs,
              parentModel,
            });
            messageQueue.close();
            break;
          }
          lastDegenerateOutput = output;
          // Only count as degenerate when worker has NO tool calls this turn.
          // If the worker is still calling tools, it's making progress.
          if (!hasCompletedWork(tracker.getToolCalls())) {
            degenerateRetries++;
            if (degenerateRetries >= MAX_DEGENERATE_RETRIES) {
              completedResult = buildClaudeIncompleteResult({
                tracker,
                scratchpad,
                providerConfig,
                sdkCostUSD: costUSD,
                inputTokens,
                outputTokens,
                turns,
                reason: `supervision loop exhausted after ${degenerateRetries} degenerate retries without tool calls (last kind: ${validation.kind ?? 'unknown'})`,
                durationMs: Date.now() - taskStartMs,
                parentModel,
              });
              messageQueue.close();
              break;
            }
          }

          // Push the re-prompt and continue reading the iterator.
          if (!canAffordNextTurn()) {
            completedResult = buildCostExceededResult();
            messageQueue.close();
            break;
          }
          const rePrompt = buildRePrompt(validation);
          emit({
            kind: 'injection',
            injectionType: injectionTypeFor(validation.kind),
            turn: turns,
            contentLengthChars: rePrompt.length,
          });
          messageQueue.push(userMessage(rePrompt));
        }
      }
    } catch (err) {
      // Preserve partial usage — the scratchpad may have buffered text
      // from turns that ran before the throw. Route the thrown error
      // through the shared classifier so the escalation orchestrator can
      // distinguish abort / network / HTTP-error / generic failure modes.
      const { status, reason } = classifyError(err);
      const msg = err instanceof Error ? err.message : String(err);
      emit({ kind: 'done', status });
      const hasSalvage = !scratchpad.isEmpty();
      const finalCostUSD = effectiveClaudeCost(providerConfig, inputTokens, outputTokens, costUSD);
      const savedCostUSD = computeSavedCostUSD(finalCostUSD, inputTokens, outputTokens, parentModel);
      return {
        output: hasSalvage ? scratchpad.latest() : `Sub-agent error: ${msg}`,
        status,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          costUSD: finalCostUSD,
          savedCostUSD,
        },
        turns,
        filesRead: tracker.getReads(),
        directoriesListed: tracker.getDirectoriesListed(),
        filesWritten: tracker.getWrites(),
        toolCalls: tracker.getToolCalls(),
        outputIsDiagnostic: !hasSalvage,
        escalationLog: [],
        error: msg || reason,
        durationMs: Date.now() - taskStartMs,
      };
    }

    // Every `break` inside the iterator above assigned `completedResult`
    // before exiting. If the iterator drained without any break (e.g. the
    // SDK closed the stream cleanly without ever emitting a final
    // `result`), synthesize an incomplete result so the caller always
    // gets a meaningful diagnostic instead of undefined.
    if (completedResult) {
      emit({ kind: 'done', status: completedResult.status });
      return completedResult;
    }
    const drained = buildClaudeIncompleteResult({
      tracker,
      scratchpad,
      providerConfig,
      sdkCostUSD: costUSD,
      inputTokens,
      outputTokens,
      turns,
      durationMs: Date.now() - taskStartMs,
      parentModel,
    });
    emit({ kind: 'done', status: drained.status });
    return drained;
  };

  return withTimeout(
    run(),
    timeoutMs,
    () => {
      emit({ kind: 'done', status: 'timeout' });
      const hasSalvage = !scratchpad.isEmpty();
      const finalCostUSD = effectiveClaudeCost(providerConfig, inputTokens, outputTokens, costUSD);
      const savedCostUSD = computeSavedCostUSD(finalCostUSD, inputTokens, outputTokens, parentModel);
      return {
        output: hasSalvage ? scratchpad.latest() : `Agent timed out after ${timeoutMs}ms.`,
        status: 'timeout',
        filesRead: tracker.getReads(),
        directoriesListed: tracker.getDirectoriesListed(),
        filesWritten: tracker.getWrites(),
        toolCalls: tracker.getToolCalls(),
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          costUSD: finalCostUSD,
          savedCostUSD,
        },
        turns,
        outputIsDiagnostic: !hasSalvage,
        escalationLog: [],
        durationMs: Date.now() - taskStartMs,
      };
    },
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
  args: ClaudeResultCommonArgs & { output: string; durationMs: number; parentModel?: string },
): RunResult {
  const { tracker, providerConfig, sdkCostUSD, inputTokens, outputTokens, turns, output, durationMs, parentModel } = args;
  const costUSD = effectiveClaudeCost(providerConfig, inputTokens, outputTokens, sdkCostUSD);
  const savedCostUSD = computeSavedCostUSD(costUSD, inputTokens, outputTokens, parentModel);
  return {
    output,
    status: 'ok',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUSD,
      savedCostUSD,
    },
    turns,
    filesRead: tracker.getReads(),
    directoriesListed: tracker.getDirectoriesListed(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
    // `ok` always carries a real model answer — never a diagnostic.
    outputIsDiagnostic: false,
    escalationLog: [],
    durationMs,
  };
}

/**
 * Supervision-exhausted path: retry cap hit or same-output early-out. Prefer
 * scratchpad salvage; fall back to the incomplete diagnostic.
 */
function buildClaudeIncompleteResult(
  args: ClaudeResultCommonArgs & { reason?: string; durationMs: number; parentModel?: string },
): RunResult {
  const { tracker, scratchpad, providerConfig, sdkCostUSD, inputTokens, outputTokens, turns, reason, durationMs, parentModel } = args;
  const filesRead = tracker.getReads();
  const filesWritten = tracker.getWrites();
  const costUSD = effectiveClaudeCost(providerConfig, inputTokens, outputTokens, sdkCostUSD);
  const savedCostUSD = computeSavedCostUSD(costUSD, inputTokens, outputTokens, parentModel);
  const hasSalvage = !scratchpad.isEmpty();
  return {
    output: hasSalvage
      ? scratchpad.latest()
      : buildClaudeIncompleteDiagnostic({
          turns,
          inputTokens,
          outputTokens,
          filesRead,
          filesWritten,
        }),
    status: 'incomplete',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUSD,
      savedCostUSD,
    },
    turns,
    filesRead,
    directoriesListed: tracker.getDirectoriesListed(),
    filesWritten,
    toolCalls: tracker.getToolCalls(),
    outputIsDiagnostic: !hasSalvage,
    escalationLog: [],
    error: reason,
    durationMs,
  };
}

function buildClaudeForceSalvageResult(
  args: ClaudeResultCommonArgs & { softLimit: number; durationMs: number; parentModel?: string },
): RunResult {
  const { tracker, scratchpad, providerConfig, sdkCostUSD, inputTokens, outputTokens, turns, softLimit, durationMs, parentModel } = args;
  const costUSD = effectiveClaudeCost(providerConfig, inputTokens, outputTokens, sdkCostUSD);
  const savedCostUSD = computeSavedCostUSD(costUSD, inputTokens, outputTokens, parentModel);
  const hasSalvage = !scratchpad.isEmpty();
  return {
    output: hasSalvage
      ? scratchpad.latest()
      : `[claude sub-agent forcibly terminated at ${inputTokens} input tokens (soft limit ${softLimit}). No usable text was buffered.]`,
    status: 'incomplete',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUSD,
      savedCostUSD,
    },
    turns,
    filesRead: tracker.getReads(),
    directoriesListed: tracker.getDirectoriesListed(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
    outputIsDiagnostic: !hasSalvage,
    escalationLog: [],
    durationMs,
  };
}

function buildClaudeMaxTurnsResult(
  args: ClaudeResultCommonArgs & { maxTurns: number; lastOutput: string; reason?: string; durationMs: number; parentModel?: string },
): RunResult {
  const { tracker, scratchpad, providerConfig, sdkCostUSD, inputTokens, outputTokens, turns, maxTurns, lastOutput, reason, durationMs, parentModel } = args;
  const hasSalvage = !scratchpad.isEmpty();
  // Note: `lastOutput` here is the model's last streamed text before the
  // max-turns boundary — NOT a diagnostic template. If the scratchpad has
  // nothing but `lastOutput` is non-empty, that's still real model content,
  // so outputIsDiagnostic is false. Only the `Agent exceeded max turns…`
  // fallback (empty scratchpad AND empty lastOutput) is a diagnostic.
  const output = hasSalvage
    ? scratchpad.latest()
    : (lastOutput || `Agent exceeded max turns (${maxTurns}).`);
  const outputIsDiagnostic = !hasSalvage && !lastOutput;
  const costUSD = effectiveClaudeCost(providerConfig, inputTokens, outputTokens, sdkCostUSD);
  const savedCostUSD = computeSavedCostUSD(costUSD, inputTokens, outputTokens, parentModel);
  return {
    output,
    status: 'incomplete',
    errorCode: 'degenerate_exhausted',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUSD,
      savedCostUSD,
    },
    turns,
    filesRead: tracker.getReads(),
    directoriesListed: tracker.getDirectoriesListed(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
    outputIsDiagnostic,
    escalationLog: [],
    error: reason,
    durationMs,
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
