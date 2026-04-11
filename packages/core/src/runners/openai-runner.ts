import {
  Agent,
  run as agentRun,
  setTracingDisabled,
  OpenAIChatCompletionsModel,
  MaxTurnsExceededError,
} from '@openai/agents';
import type { RunItem, AgentInputItem } from '@openai/agents';
import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import {
  withTimeout,
  computeCostUSD,
  computeSavedCostUSD,
  type RunResult,
  type RunOptions,
  type ProviderConfig,
  type ProgressEvent,
} from '../types.js';
import { trimProgressTrace } from './supervision.js';
import { injectionTypeFor } from './injection-type.js';

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
  buildBudgetPressureNudge,
  RE_GROUNDING_INTERVAL_TURNS,
} from './prevention.js';
import {
  validateCompletion,
  validateCoverage,
  validateSubAgentOutput,
  buildRePrompt,
  sameDegenerateOutput,
  resolveInputTokenSoftLimit,
  checkWatchdogThreshold,
  logWatchdogEvent,
  THINKING_DIAGNOSTIC_MARKER,
} from './supervision.js';
import { classifyError } from './error-classification.js';
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

/** Maximum turns for each continuation (reprompt/reground/watchdog-warning) in the
 * supervision loop. Higher than the old hardcoded 1 so the model can call a tool
 * and reply to the tool result without immediately exhausting the sub-budget. */
const SUPERVISION_CONTINUATION_BUDGET = 5;

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

  // --- Task timing + parent model (Task 9) --------------------------------
  const taskStartMs = Date.now();
  const parentModel = options.parentModel;

  // --- Progress trace capture (Task 10) ---------------------------------
  const shouldCaptureTrace = options.includeProgressTrace ?? false;
  const traceBuffer: ProgressEvent[] = [];

  // --- Progress event emission (Task 9) -----------------------------------
  //
  // `onProgress` is already wrapped in `safeSink` by the orchestrator
  // (Task 8), so any throw from the consumer callback is swallowed
  // upstream and cannot corrupt this loop. We do not need to wrap it
  // again here.
  const onProgress = options.onProgress;
  const emit = (event: ProgressEvent): void => {
    if (shouldCaptureTrace) traceBuffer.push(event);
    if (onProgress) onProgress(event);
  };

  // Hoisted out of `run()` so the withTimeout callback (which runs in a
  // different microtask chain) can still read partial usage from the last
  // successful agentRun. `run()` updates this on every turn. Declared
  // here (before the tracker) so the FileTracker callback closure can
  // reference it without a TDZ issue at construction.
  let currentResult: AgentRunOutput | undefined;

  // The tracker fires `onToolCall` synchronously inside every
  // `trackToolCall(...)` — which itself is called from inside a tool
  // implementation during an `agentRun` turn. That means `currentResult`
  // may still hold the PREVIOUS turn's request count when the callback
  // fires. We read it with an optional chain + fallback and attribute
  // the tool call to the in-flight turn (previous turn + 1).
  const tracker = new FileTracker((summary) => {
    const inflightTurn = (currentResult?.state.usage.requests ?? 0) + 1;
    emit({ kind: 'tool_call', turn: inflightTurn, toolSummary: summary });
  });
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

  // --- onInitialRequest (Task 12) ----------------------------------------
  //
  // Fire once per attempt with the canonical orchestrator-side initial
  // brief: `${systemPrompt}\n\n${promptWithBudgetHint}`. This is NOT the
  // literal request body the `@openai/agents` SDK transmits — the SDK
  // wraps our systemPrompt in the Agent `instructions` field and our
  // user prompt in a messages array. We hash the canonical form instead
  // so the hash is cross-runner stable: the same canonical brief on any
  // of the three runners produces the same hash, even though each SDK's
  // wire format differs. This answers "did the orchestrator send the
  // same brief across retries?" — not "were the literal wire bytes
  // identical?". See `AttemptRecord.initialPromptHash` in types.ts for
  // the full caveat. We guard with try/catch because the orchestrator
  // owns the callback and a throw would corrupt its closure (symmetry
  // with safeSink around onProgress).
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

  /**
   * Local helper: run one agent turn and buffer its assistant text into
   * the scratchpad. Closes over `agent`, `abortController`, `scratchpad`
   * and `emit` so every call site in `run()` is just one line AND every
   * turn automatically emits the correct `turn_start` / `text_emission`
   * / `turn_complete` progress events.
   *
   * Event ordering:
   *   1. `turn_start` — fires BEFORE agentRun. Turn number is the NEXT
   *      request count (prev + 1) because the SDK won't bump
   *      `state.usage.requests` until the call completes.
   *   2. `text_emission` — fires AFTER scratchpad.append, only when the
   *      stripped assistant text is non-empty. Skipping empty emissions
   *      keeps the event stream useful (empty-text turns are observable
   *      via `turn_complete` alone).
   *   3. `turn_complete` — fires AFTER agentRun, with the post-call
   *      cumulative usage from `result.state.usage`.
   */
  const runTurnAndBuffer = async (
    input: string | AgentInputItem[],
    turnBudget: number,
  ): Promise<AgentRunOutput> => {
    const nextTurn = (currentResult?.state.usage.requests ?? 0) + 1;
    emit({ kind: 'turn_start', turn: nextTurn, provider: 'openai-compatible' });
    const result = (await agentRun(agent, input, {
      maxTurns: turnBudget,
      signal: abortController.signal,
    })) as AgentRunOutput;
    const text = stripThinkingTags(extractAssistantText(result.newItems));
    scratchpad.append(result.state.usage.requests, text);
    if (text.length > 0) {
      emit({
        kind: 'text_emission',
        turn: result.state.usage.requests,
        chars: text.length,
        preview: text.slice(0, 200),
      });
    }
    emit({
      kind: 'turn_complete',
      turn: result.state.usage.requests,
      cumulativeInputTokens: result.state.usage.inputTokens,
      cumulativeOutputTokens: result.state.usage.outputTokens,
    });
    return result;
  };

  const run = async (): Promise<RunResult> => {
    try {
      currentResult = await runTurnAndBuffer(promptWithBudgetHint, maxTurns);

      let supervisionRetries = 0;
      // Continuation-exhausted flag: set when runContinuationTurn catches a
      // MaxTurnsExceededError on a re-prompt or re-ground continuation.
      // The break below lands in the exhausted handler so we don't conflate
      // a 5-turn sub-budget exhaustion with the user-declared maxTurns limit.
      let supervisionExhausted = false;
      // Initialized to `null` (NOT ''): on the first turn there is no
      // previous degenerate output to compare against, so the
      // same-output early-out must be skipped. Initialising to ''
      // would cause `sameDegenerateOutput('', '')` to fire on a first-
      // turn empty output and break the loop before retries run.
      let lastDegenerateOutput: string | null = null;
      // Track the input-token count at which we last fired a warning
      // nudge. This prevents nudging twice in a row for the same
      // `currentResult` when validation still fails after a nudge
      // response: the next loop iteration will see
      // `currentInputTokens <= lastWarnedInputTokens` and fall through
      // to validation / re-prompt instead of re-issuing the nudge.
      let lastWarnedInputTokens = -1;
      let lastValidationKind: string | undefined = undefined;

      /**
       * Wraps a continuation turn (re-prompt or re-ground) that uses a small
       * fixed budget. Catches MaxTurnsExceededError from the SDK and returns a
       * discriminated union so callers can handle exhaustion without conflating it
       * with the user-declared maxTurns limit.
       */
      async function runContinuationTurn(
        currentResult: AgentRunOutput,
        instruction: string,
        budget: number,
      ): Promise<
        | { ok: true; result: AgentRunOutput }
        | { ok: false; cause: MaxTurnsExceededError; label: 'continuation_exhausted'; turnAtFailure: number }
      > {
        try {
          const result = await runTurnAndBuffer(continueWith(currentResult, instruction), budget);
          return { ok: true, result };
        } catch (err) {
          if (err instanceof MaxTurnsExceededError) {
            return { ok: false, cause: err, label: 'continuation_exhausted', turnAtFailure: currentResult.state.usage.requests };
          }
          throw err;
        }
      }

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
          // `watchdog_force_salvage` is not an injected message — no
          // re-prompt is sent — but observers still want to see exactly
          // why the run is being killed. We emit the event with a
          // `contentLengthChars` of 0 to reflect the "nothing was
          // injected, we just terminated" semantics.
          emit({
            kind: 'injection',
            injectionType: 'watchdog_force_salvage',
            turn: currentResult.state.usage.requests,
            contentLengthChars: 0,
          });
          const salvaged = buildForceSalvageResult(
            currentResult,
            scratchpad,
            tracker,
            runner.providerConfig,
            softLimit,
            Date.now() - taskStartMs,
            parentModel,
            shouldCaptureTrace ? traceBuffer : undefined,
          );
          emit({ kind: 'done', status: salvaged.status });
          return salvaged;
        }

        // Warning-band nudge: fire at most once per distinct input-token
        // level. We dispatch the nudge turn, append to the scratchpad,
        // record the new high-watermark, and then FALL THROUGH to the
        // validation block below — the nudge response might itself be a
        // perfectly valid final answer, so we must validate it in the
        // SAME iteration. Without the fall-through, a valid nudge
        // response would be thrown away and the loop would grind until
        // force_salvage (pre-fix bug #1).
        if (watchdogStatus === 'warning' && currentInputTokens > lastWarnedInputTokens) {
          const warning = buildBudgetPressureNudge({
            inputTokens: currentInputTokens,
            softLimit,
          });
          emit({
            kind: 'injection',
            injectionType: 'watchdog_warning',
            turn: currentResult.state.usage.requests,
            contentLengthChars: warning.length,
          });
          lastWarnedInputTokens = currentInputTokens;
          const warningCont = await runContinuationTurn(currentResult, warning, SUPERVISION_CONTINUATION_BUDGET);
          if (!warningCont.ok) {
            supervisionExhausted = true;
            break;
          }
          currentResult = warningCont.result;
        }

        // --- Validation check ---
        const stripped = stripThinkingTags(currentResult.finalOutput ?? '');
        const validation = validateSubAgentOutput(stripped, {
          expectedCoverage: options.expectedCoverage,
          skipCompletionHeuristic: options.skipCompletionHeuristic,
        });

        if (validation.valid) {
          const ok = buildOkResult(stripped, currentResult, tracker, runner.providerConfig, Date.now() - taskStartMs, parentModel, shouldCaptureTrace ? traceBuffer : undefined);
          emit({ kind: 'done', status: ok.status });
          return ok;
        }

        // Track last validation kind so the exhausted handler can report it.
        lastValidationKind = validation.kind;

        // Degenerate. Apply same-output early-out (only when we have a
        // prior degenerate output to compare against) and retry budget.
        if (lastDegenerateOutput !== null && sameDegenerateOutput(stripped, lastDegenerateOutput)) break;
        lastDegenerateOutput = stripped;
        supervisionRetries++;
        if (supervisionRetries >= MAX_SUPERVISION_RETRIES) break;

        // --- Re-prompt the model to recover ---
        const rePrompt = buildRePrompt(validation);
        emit({
          kind: 'injection',
          injectionType: injectionTypeFor(validation.kind),
          turn: currentResult.state.usage.requests,
          contentLengthChars: rePrompt.length,
        });
        // Give the model a small budget to recover. One extra turn per
        // retry is enough for the "emit your final answer" nudge.
        const rePromptCont = await runContinuationTurn(currentResult, rePrompt, SUPERVISION_CONTINUATION_BUDGET);
        if (!rePromptCont.ok) {
          supervisionExhausted = true;
          break;
        }
        currentResult = rePromptCont.result;

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
          emit({
            kind: 'injection',
            injectionType: 'reground',
            turn: currentResult.state.usage.requests,
            contentLengthChars: reground.length,
          });
          const regroundCont = await runContinuationTurn(currentResult, reground, SUPERVISION_CONTINUATION_BUDGET);
          if (!regroundCont.ok) {
            supervisionExhausted = true;
            break;
          }
          currentResult = regroundCont.result;
        }
      }

      // Supervision exhausted (either retry budget or same-output early-out or
      // continuation-exhausted break). Salvage from the scratchpad if we have
      // anything; otherwise return the existing incomplete diagnostic.
      const exhaustedReason = supervisionExhausted
        ? `supervision continuation sub-budget exhausted at turn ${currentResult.state.usage.requests}`
        : `supervision loop exhausted after ${supervisionRetries} re-prompts (last kind: ${lastValidationKind ?? 'unknown'})`;
      const exhausted = buildSupervisionExhaustedResult(
        currentResult,
        scratchpad,
        tracker,
        runner.providerConfig,
        Date.now() - taskStartMs,
        parentModel,
        shouldCaptureTrace ? traceBuffer : undefined,
        { reason: exhaustedReason },
      );
      emit({ kind: 'done', status: exhausted.status });
      return exhausted;
    } catch (err) {
      if (err instanceof MaxTurnsExceededError) {
        // max_turns path: prefer scratchpad salvage over the bare diagnostic.
        // Preserve whatever partial usage we accumulated in the last
        // successful agentRun so the caller sees real numbers, not zeros.
        const filesRead = tracker.getReads();
        const filesWritten = tracker.getWrites();
        const toolCalls = tracker.getToolCalls();
        const partial = partialUsage(currentResult, runner.providerConfig);
        const savedCostUSD = computeSavedCostUSD(
          partial.costUSD,
          partial.inputTokens,
          partial.outputTokens,
          parentModel,
        );
        emit({ kind: 'done', status: 'max_turns' });
        const hasSalvage = !scratchpad.isEmpty();
        const turnsAtFailure = currentResult?.state.usage.requests ?? maxTurns;
        return {
          output: hasSalvage
            ? scratchpad.latest()
            : `Agent exceeded max turns (${maxTurns}).`,
          status: 'max_turns',
          error: `agent exhausted user-declared maxTurns limit (${maxTurns}) after ${turnsAtFailure} turns`,
          usage: { ...partial, savedCostUSD },
          turns: turnsAtFailure,
          filesRead,
          directoriesListed: tracker.getDirectoriesListed(),
          filesWritten,
          toolCalls,
          outputIsDiagnostic: !hasSalvage,
          escalationLog: [],
          durationMs: Date.now() - taskStartMs,
          ...(shouldCaptureTrace && { progressTrace: trimProgressTrace(traceBuffer) }),
        };
      }
      // Classify the thrown error into a finer-grained RunStatus so the
      // escalation orchestrator (and downstream observers) can distinguish
      // abort / network / HTTP-error / generic failure modes. We still
      // surface the original error message as the `error` field — the
      // classifier's `reason` is deliberately a stable category label and
      // NOT the human-readable message.
      const { status, reason } = classifyError(err);
      const msg = err instanceof Error ? err.message : String(err);
      emit({ kind: 'done', status });
      const hasSalvage = !scratchpad.isEmpty();
      const partial = partialUsage(currentResult, runner.providerConfig);
      const savedCostUSD = computeSavedCostUSD(
        partial.costUSD,
        partial.inputTokens,
        partial.outputTokens,
        parentModel,
      );
      return {
        output: hasSalvage ? scratchpad.latest() : `Sub-agent error: ${msg}`,
        status,
        usage: { ...partial, savedCostUSD },
        turns: currentResult?.state.usage.requests ?? 0,
        filesRead: tracker.getReads(),
        directoriesListed: tracker.getDirectoriesListed(),
        filesWritten: tracker.getWrites(),
        toolCalls: tracker.getToolCalls(),
        outputIsDiagnostic: !hasSalvage,
        escalationLog: [],
        error: msg || reason,
        durationMs: Date.now() - taskStartMs,
        ...(shouldCaptureTrace && { progressTrace: trimProgressTrace(traceBuffer) }),
      };
    }
  };

  return withTimeout(
    run(),
    timeoutMs,
    () => {
      emit({ kind: 'done', status: 'timeout' });
      const hasSalvage = !scratchpad.isEmpty();
      const partial = partialUsage(currentResult, runner.providerConfig);
      const savedCostUSD = computeSavedCostUSD(
        partial.costUSD,
        partial.inputTokens,
        partial.outputTokens,
        parentModel,
      );
      return {
        output: hasSalvage
          ? scratchpad.latest()
          : `Agent timed out after ${timeoutMs}ms.`,
        status: 'timeout',
        filesRead: tracker.getReads(),
        directoriesListed: tracker.getDirectoriesListed(),
        filesWritten: tracker.getWrites(),
        toolCalls: tracker.getToolCalls(),
        // Preserve partial usage from the last successful agentRun so the
        // caller sees real numbers, not zeros, on a timeout.
        usage: { ...partial, savedCostUSD },
        turns: currentResult?.state.usage.requests ?? maxTurns,
        outputIsDiagnostic: !hasSalvage,
        escalationLog: [],
        durationMs: Date.now() - taskStartMs,
        ...(shouldCaptureTrace && { progressTrace: trimProgressTrace(traceBuffer) }),
      };
    },
    abortController,
  );
}

// --- Helpers: canonical return-shape builders -------------------------------

function buildOkResult(
  output: string,
  currentResult: AgentRunOutput,
  tracker: FileTracker,
  providerConfig: ProviderConfig,
  durationMs: number,
  parentModel?: string,
  traceBuffer?: ProgressEvent[],
): RunResult {
  const usage = currentResult.state.usage;
  const costUSD = computeCostUSD(usage.inputTokens, usage.outputTokens, providerConfig);
  const savedCostUSD = computeSavedCostUSD(costUSD, usage.inputTokens, usage.outputTokens, parentModel);
  return {
    output,
    status: 'ok',
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costUSD,
      savedCostUSD,
    },
    turns: usage.requests,
    filesRead: tracker.getReads(),
    directoriesListed: tracker.getDirectoriesListed(),
    filesWritten: tracker.getWrites(),
    toolCalls: tracker.getToolCalls(),
    // `ok` always carries a real model answer — never a diagnostic.
    outputIsDiagnostic: false,
    escalationLog: [],
    durationMs,
    ...(traceBuffer && { progressTrace: trimProgressTrace(traceBuffer) }),
  };
}

function buildSupervisionExhaustedResult(
  currentResult: AgentRunOutput,
  scratchpad: TextScratchpad,
  tracker: FileTracker,
  providerConfig: ProviderConfig,
  durationMs: number,
  parentModel?: string,
  traceBuffer?: ProgressEvent[],
  opts?: { reason?: string },
): RunResult {
  const usage = currentResult.state.usage;
  const filesRead = tracker.getReads();
  const filesWritten = tracker.getWrites();
  const toolCalls = tracker.getToolCalls();
  const costUSD = computeCostUSD(usage.inputTokens, usage.outputTokens, providerConfig);
  const savedCostUSD = computeSavedCostUSD(costUSD, usage.inputTokens, usage.outputTokens, parentModel);
  const hasSalvage = !scratchpad.isEmpty();
  return {
    output: hasSalvage
      ? scratchpad.latest()
      : buildIncompleteDiagnostic({
          providerLabel: 'openai-compatible',
          turns: usage.requests,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          filesRead,
          filesWritten,
        }),
    status: 'incomplete',
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costUSD,
      savedCostUSD,
    },
    turns: usage.requests,
    filesRead,
    directoriesListed: tracker.getDirectoriesListed(),
    filesWritten,
    toolCalls,
    outputIsDiagnostic: !hasSalvage,
    escalationLog: [],
    ...(opts?.reason && { error: opts.reason }),
    durationMs,
    ...(traceBuffer && { progressTrace: trimProgressTrace(traceBuffer) }),
  };
}

function buildForceSalvageResult(
  currentResult: AgentRunOutput,
  scratchpad: TextScratchpad,
  tracker: FileTracker,
  providerConfig: ProviderConfig,
  softLimit: number,
  durationMs: number,
  parentModel?: string,
  traceBuffer?: ProgressEvent[],
): RunResult {
  const usage = currentResult.state.usage;
  const filesRead = tracker.getReads();
  const filesWritten = tracker.getWrites();
  const toolCalls = tracker.getToolCalls();
  const costUSD = computeCostUSD(usage.inputTokens, usage.outputTokens, providerConfig);
  const savedCostUSD = computeSavedCostUSD(costUSD, usage.inputTokens, usage.outputTokens, parentModel);
  const hasSalvage = !scratchpad.isEmpty();
  return {
    output: hasSalvage
      ? scratchpad.latest()
      : `[openai-compatible sub-agent forcibly terminated at ${usage.inputTokens} input tokens (soft limit ${softLimit}). No usable text was buffered.]`,
    status: 'incomplete',
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costUSD,
      savedCostUSD,
    },
    turns: usage.requests,
    filesRead,
    directoriesListed: tracker.getDirectoriesListed(),
    filesWritten,
    toolCalls,
    outputIsDiagnostic: !hasSalvage,
    escalationLog: [],
    durationMs,
    ...(traceBuffer && { progressTrace: trimProgressTrace(traceBuffer) }),
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

/**
 * Read whatever usage we managed to accumulate from the last successful
 * `agentRun` before a throw, max_turns, or timeout. Used by every
 * non-happy-path return so the caller sees real token counts (and a
 * real cost estimate) instead of zeros.
 */
function partialUsage(
  result: AgentRunOutput | undefined,
  providerConfig: ProviderConfig,
): RunResult['usage'] {
  if (!result) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null };
  }
  const usage = result.state.usage;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    costUSD: computeCostUSD(usage.inputTokens, usage.outputTokens, providerConfig),
  };
}
