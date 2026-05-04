import {
  Agent,
  run as agentRun,
  setTracingDisabled,
  OpenAIChatCompletionsModel,
  MaxTurnsExceededError,
  tool,
} from '@openai/agents';
import type { RunItem, AgentInputItem } from '@openai/agents';
import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  withTimeout,
  type RunResult,
  type ProviderConfig,
  type ToolMode,
  type ReviewPromptParts,
  type ReviewRunOptions,
} from '../types.js';
import { priceTokens, subtractTokens, resolveRateCard, type TokenCounts, type RateCard } from '../cost/compute.js';
import type { InternalRunnerEvent, RunOptions } from './types.js';
import { injectionTypeFor } from './injection-type.js';
import {
  reviewerEmittedFindingSchema,
  evidenceIsGrounded,
} from '../executors/_shared/findings-schema.js';
import type { AnnotatedFinding } from '../executors/_shared/findings-schema.js';

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
  state: { usage: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number; inputTokensDetails?: Array<Record<string, number>>; outputTokensDetails?: Array<Record<string, number>> } };
  history: AgentInputItem[];
  finalOutput?: unknown;
  newItems: RunItem[];
}
import { FileTracker } from '../tools/tracker.js';
import { createToolImplementations } from '../tools/definitions.js';
import { createOpenAITools } from '../tools/openai-adapter.js';
import { TextScratchpad } from '../tools/scratchpad.js';
import { CostMeter } from '../cost/cost-meter.js';
import { CallCache } from '../tools/call-cache.js';
import {
  buildSystemPrompt,
  buildBudgetHint,
  buildReGroundingMessage,
  buildFormatConstraintSuffix,
  RE_GROUNDING_INTERVAL_TURNS,
} from './prevention.js';
import {
  validateSubAgentOutput,
  buildRePrompt,
  sameDegenerateOutput,
  THINKING_DIAGNOSTIC_MARKER,
  hasCompletedWork,
  MAX_DEGENERATE_RETRIES,
  STALL_DETECTION_TURNS,
  detectToolCallLoop,
  hasNewFileActivity,
} from './supervision.js';
import { classifyError, isRateLimit, isProviderContextLimit } from './error-classification.js';
import {
  buildOkResult as sharedBuildOkResult,
  buildIncompleteResult as sharedBuildIncompleteResult,
  buildTimeCeilingResult as sharedBuildTimeCeilingResult,
  type SharedResultUsage,
} from './base/result-builders.js';
import { checkTimeCeiling } from './base/time-check.js';
import { type CanonicalUsage } from './base/usage-accumulator.js';

// Disable tracing — not all OpenAI-compatible providers support it
setTracingDisabled(true);

/**
 * OpenAI Structured Outputs requires an object root (not a bare array). The
 * `findings` field carries the array of reviewer-emitted findings. After the
 * run, each finding is annotated with `evidenceGrounded` to produce the
 * final `AnnotatedFinding[]` stored in `RunResult.parsedFindings`.
 */
const reviewerOutputType = z.object({
  findings: z.array(reviewerEmittedFindingSchema),
}).strict();

/**
 * Normalize a {@link ResearchToolDefinition.inputSchema} to a Zod schema.
 * Research adapters supply either a Zod schema directly or a JSON-Schema object;
 * the OpenAI Agents SDK requires Zod schemas for tool parameters, so we convert
 * JSON-Schema via {@link z.fromJSONSchema} when needed.
 */
function normalizeCustomToolSchema(inputSchema: unknown): z.ZodType {
  if (inputSchema instanceof z.ZodType) return inputSchema;
  try {
    const jsonSchema = inputSchema as Record<string, unknown>;
    return z.fromJSONSchema(jsonSchema);
  } catch {
    return z.object({}).passthrough();
  }
}

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
  defaults: { timeoutMs: number; tools: ToolMode };
  /** Optional HTTP-level usage capture; when present, the runner prefers it
   *  over `state.usage` whenever the SDK reports zero tokens despite turns
   *  having occurred (DeepSeek streaming path drops usage on multi-turn
   *  tool-use; see openai-usage-interceptor.ts for the SDK source).
   *  Provider.ts wraps `client.chat.completions.create` and passes the
   *  resulting accumulator here. */
  usageAccumulator?: import('./openai-usage-interceptor.js').UsageAccumulator;
}

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
  const timeoutMs = options.timeoutMs ?? runner.providerConfig.timeoutMs ?? runner.defaults.timeoutMs;
  const toolMode = options.tools ?? runner.defaults.tools;
  const cwd = options.cwd ?? process.cwd();
  const effort = options.effort ?? runner.providerConfig.effort;
  const runMode = options.runMode ?? 'standard';

  const sandboxPolicy = options.sandboxPolicy ?? runner.providerConfig.sandboxPolicy ?? 'cwd-only';
  const abortController = new AbortController();

  // --- Task timing + parent model (Task 9) --------------------------------
  const taskStartMs = Date.now();
  const parentModel = options.parentModel;

  // --- Progress event emission (Task 9) -----------------------------------
  //
  // `onProgress` is already wrapped in `safeSink` by the orchestrator
  // (Task 8), so any throw from the consumer callback is swallowed
  // upstream and cannot corrupt this loop. We do not need to wrap it
  // again here.
  const onProgress = options.onProgress;
  const emit = (event: InternalRunnerEvent): void => {
    if (onProgress) onProgress(event);
  };

  // --- Cost meter (Task 25) ------------------------------------------------
  const costMeter = new CostMeter({ ceiling: options.maxCostUSD });

  // --- Call cache (Task 25) ------------------------------------------------
  const callCache = new CallCache();
  const agentType = runner.providerConfig.type ?? 'openai-compatible';

  // Hoisted out of `run()` so the withTimeout callback (which runs in a
  // different microtask chain) can still read partial usage from the last
  // successful agentRun. `run()` updates this on every turn. Declared
  // here (before the tracker) so the FileTracker callback closure can
  // reference it without a TDZ issue at construction.
  let currentResult: AgentRunOutput | undefined;

  // Track last turn cost for estimating next turn cost (used by runTurnAndBuffer)
  let lastTurnCostUSD = 0;

  // Per-turn cumulative → delta tracking state (§3.5 point 2)
  let lastCumulative: TokenCounts = {
    inputTokens: 0, outputTokens: 0,
    cachedReadTokens: 0, cachedCreationTokens: 0, reasoningTokens: 0,
  };

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
  const fileTools = createOpenAITools(toolImpls, sandboxPolicy, toolMode);

  // Add hosted tools (web_search, image_generation, etc.) if configured — only when tools are enabled
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hostedTools = toolMode !== 'none'
    ? (runner.providerConfig.hostedTools ?? []).map(t => ({ type: t } as any))
    : [];
  const tools = [...fileTools, ...hostedTools];

  // --- Custom toolset injection (explore executor, taskIndex=1) ---
  if (options.customToolset && options.customToolset.length > 0) {
    for (const ct of options.customToolset) {
      const params = ct.inputSchema instanceof z.ZodType
        ? ct.inputSchema
        : normalizeCustomToolSchema(ct.inputSchema);
      tools.push(tool({
        name: ct.name,
        description: ct.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: params as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (args: any) => ct.invoke(args),
      }));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new OpenAIChatCompletionsModel(runner.client as any, runner.providerConfig.model);

  // --- Prevention layer: system prompt + budget hint ---
  //
  // buildSystemPrompt() is deliberately static and parameter-free. The Task 1
  // review rejected speculative `providerLabel` parameters — the system prompt
  // is generic ~400 tokens of discipline that applies to every provider.
  // Budget information is threaded through buildBudgetHint (prepended to the
  // first user prompt) and buildReGroundingMessage (injected every
  // RE_GROUNDING_INTERVAL_TURNS turns).
  const systemPrompt = buildSystemPrompt() + buildFormatConstraintSuffix(options.formatConstraints ?? {});
  const instructions = options.instructionsSuffix
    ? `${systemPrompt}\n\n${options.instructionsSuffix}`
    : systemPrompt;
  const budgetHint = buildBudgetHint({ timeoutMs, maxCostUSD: options.maxCostUSD });
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

  // DeepSeek's V4 hybrid models default to thinking mode and emit a
  // `reasoning_content` field on every assistant turn. The OpenAI Chat
  // Completions wire format the @openai/agents SDK uses doesn't preserve
  // that field across turns, which causes a 400 on the second turn
  // ("reasoning_content ... must be passed back to the API"). For users
  // who put DeepSeek behind `openai-compatible` we opt out of thinking
  // so multi-turn tool use works. Users who want DeepSeek's reasoning ON
  // should configure it as `claude-compatible` instead — the Anthropic
  // wire format preserves thinking blocks natively.
  const baseUrl = (runner.providerConfig as { baseUrl?: string }).baseUrl ?? '';
  const isDeepSeek = /(?:^|[\\/.])deepseek\b/i.test(baseUrl)
    || /^deepseek-/i.test(runner.providerConfig.model);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providerData: Record<string, any> = {};
  if (isDeepSeek) providerData.thinking = { type: 'disabled' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const modelSettings: any = {};
  if (effort && effort !== 'none') modelSettings.reasoning = { effort };
  if (Object.keys(providerData).length > 0) modelSettings.providerData = providerData;

  // outputType is disabled for DeepSeek in review mode. DeepSeek's V4 hybrid
  // models either fail schema-conformance enforcement OR the @openai/agents
  // SDK's schema-enforcement code path skips usage aggregation on this
  // backend specifically, leaving every review call with
  // `state.usage = {inputTokens: 0, outputTokens: 0}` despite real tokens
  // being burned (3.12.2 telemetry showed every audit's quality_review with
  // 30+ turns and 0 cost). The downstream text-parser fallback in
  // runAnnotationReview (parseReviewerFindings → fallbackExtractFindings)
  // recovers findings from prose, so dropping the schema costs us nothing
  // for DeepSeek. Other openai-compatible backends (OpenAI proper,
  // structured-output-capable proxies like vLLM) keep outputType.
  const useOutputType = runMode === 'review' && !isDeepSeek;

  const agent = new Agent({
    name: 'sub-agent',
    model,
    instructions,
    tools,
    ...(Object.keys(modelSettings).length > 0 && { modelSettings }),
    ...(useOutputType && { outputType: reviewerOutputType }),
  });

  // --- Scratchpad: buffers assistant text across every agentRun() call so
  // that every termination path (ok/incomplete/max_turns/error/timeout)
  // can return the best text we heard, even if the final message is junk. ---
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
  ): Promise<AgentRunOutput> => {
    const ceilingMs = checkTimeCeiling(taskStartMs, timeoutMs);
    if (ceilingMs !== null) {
      const err = new Error('time_ceiling');
      (err as unknown as Record<string, unknown>).__timeCeiling = ceilingMs;
      throw err;
    }
    const nextTurn = (currentResult?.state.usage.requests ?? 0) + 1;
    emit({ kind: 'turn_start', turn: nextTurn, provider: 'openai-compatible', model: runner.providerConfig.model });
    const result = (await agentRun(agent, input, {
      maxTurns: Number.MAX_SAFE_INTEGER,
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
    const cachedRead = sumCachedReadTokens(result.state.usage.inputTokensDetails) ?? 0;
    const reasoning = sumReasoningTokens(result.state.usage.outputTokensDetails) ?? 0;
    emit({
      kind: 'turn_complete',
      turn: result.state.usage.requests,
      cumulativeInputTokens: result.state.usage.inputTokens,
      cumulativeOutputTokens: result.state.usage.outputTokens,
      cumulativeCachedReadTokens: cachedRead > 0 ? cachedRead : undefined,
      cumulativeReasoningTokens: reasoning > 0 ? reasoning : undefined,
    });
    // Track cost for this turn using per-turn delta from cumulative
    const cur: TokenCounts = {
      inputTokens: Math.max(0, result.state.usage.inputTokens - cachedRead),
      outputTokens: result.state.usage.outputTokens,
      cachedReadTokens: cachedRead,
      cachedCreationTokens: 0,
      reasoningTokens: reasoning,
    };
    const turnTokens = subtractTokens(cur, lastCumulative);
    lastCumulative = cur;
    const rateCard = resolveProviderRateCard(runner.providerConfig);
    const turnCost = rateCard ? priceTokens(turnTokens, rateCard) : null;
    if (turnCost !== null) {
      lastTurnCostUSD = turnCost;
      costMeter.add(turnCost);
    }
    return result;
  };

  const run = async (): Promise<RunResult> => {
    try {
      currentResult = await runTurnAndBuffer(promptWithBudgetHint);

      // --- Supervision state: monitor model replaces gatekeeper ---
      // Only count degenerate retries when worker has NO tool calls in a turn.
      // If the worker is still making tool calls, it's making progress even
      // if the output text is degenerate — don't count against budget.
      let degenerateRetries = 0;
      let stallTurnCounter = 0;
      let lastFilesRead = tracker.getReads().length;
      let lastFilesWritten = tracker.getWrites().length;
      // Continuation-exhausted flag: set when runContinuationTurn catches a
      // MaxTurnsExceededError on a re-prompt or re-ground continuation.
      // The break below lands in the exhausted handler so we don't conflate
      // a continuation-exhaustion with the user-declared limits.
      let supervisionExhausted = false;
      // Initialized to `null` (NOT ''): on the first turn there is no
      // previous degenerate output to compare against, so the
      // same-output early-out must be skipped. Initialising to ''
      // would cause `sameDegenerateOutput('', '')` to fire on a first-
      // turn empty output and break the loop before retries run.
      let lastDegenerateOutput: string | null = null;
      let lastValidationKind: string | undefined = undefined;

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
      function buildCostExceededResult(turnsAtFailure: number): RunResult {
        const partial = partialUsage(currentResult, runner.providerConfig, parentModel, runner.usageAccumulator);
        return {
          output: `Cost ceiling exceeded: maxCostUSD=${options.maxCostUSD}`,
          status: 'cost_exceeded',
          usage: partial,
          turns: turnsAtFailure,
          filesRead: tracker.getReads(),
          directoriesListed: tracker.getDirectoriesListed(),
          filesWritten: tracker.getWrites(),
          toolCalls: tracker.getToolCalls(),
          outputIsDiagnostic: true,
          escalationLog: [],
          durationMs: Date.now() - taskStartMs,
          parsedFindings: null,
        };
      }

      /**
       * Wraps a continuation turn (re-prompt or re-ground). Time and cost bounds
       * are the only effective limits; no turn-count sub-budget is imposed.
       * Catches MaxTurnsExceededError from the SDK as a safety net.
       */
      async function runContinuationTurn(
        currentResult: AgentRunOutput,
        instruction: string,
      ): Promise<
        | { ok: true; result: AgentRunOutput }
        | { ok: false; cause: MaxTurnsExceededError; label: 'continuation_exhausted'; turnAtFailure: number }
      > {
        try {
          const result = await runTurnAndBuffer(continueWith(currentResult, instruction));
          return { ok: true, result };
        } catch (err) {
          if (err instanceof MaxTurnsExceededError) {
            return { ok: false, cause: err, label: 'continuation_exhausted', turnAtFailure: currentResult.state.usage.requests };
          }
          throw err;
        }
      }

      // Supervision loop. On each iteration we:
      //   1. Validate the final message (may re-prompt)
      //   2. Inject re-grounding every RE_GROUNDING_INTERVAL_TURNS turns
      // A single pass where validateCompletion returns `valid` is the clean
      // exit. Otherwise we either re-prompt (and loop) or salvage.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // --- Validation check ---
        // In review mode the SDK returns a structured object in finalOutput
        // (from Agent.outputType). Validation text comes from newItems.
        const rawOutput = runMode === 'review'
          ? extractAssistantText(currentResult.newItems)
          : String(currentResult.finalOutput ?? '');
        const stripped = stripThinkingTags(rawOutput);
        const validation = validateSubAgentOutput(stripped, {
          expectedCoverage: options.expectedCoverage,
          skipCompletionHeuristic: options.skipCompletionHeuristic,
          hasCompletedWork: hasCompletedWork(tracker.getToolCalls()),
        });

        if (validation.valid) {
          const ok = buildOkResult(stripped, currentResult, tracker, runner.providerConfig, Date.now() - taskStartMs, parentModel, runner.usageAccumulator);

          if (runMode === 'review' && useOutputType) {
            const parsed = reviewerOutputType.safeParse(currentResult.finalOutput);
            if (parsed.success) {
              ok.parsedFindings = parsed.data.findings.map(f => ({
                ...f,
                evidenceGrounded: evidenceIsGrounded(f.evidence, stripped),
              }));
            } else {
              // OpenAI-proper structured-output failure: should be rare since
              // OpenAI honors the schema, but if it happens we still don't
              // want to discard the call — fall through to the text parser.
              ok.parsedFindings = null;
            }
          } else {
            // Review mode on non-OpenAI provider, OR delegate mode: text-parser
            // fallback in runAnnotationReview handles findings extraction.
            ok.parsedFindings = null;
          }

          emit({ kind: 'done', status: ok.status });
          return ok;
        }

        // Track last validation kind so the exhausted handler can report it.
        lastValidationKind = validation.kind;

        // --- Loop detection (advisory) ---
        // After a turn with tool calls, check for repetitive patterns.
        // If stuck in a loop, inject re-grounding — don't terminate or count as degenerate.
        if (detectToolCallLoop(tracker.getToolCalls())) {
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
            turn: currentResult.state.usage.requests,
            contentLengthChars: reground.length,
          });
          if (canAffordNextTurn()) {
              const regroundCont = await runContinuationTurn(currentResult, reground);
            if (regroundCont.ok) {
              currentResult = regroundCont.result;
              continue;
            }
          }
        }

        // --- Stall detection (advisory) ---
        // Track consecutive turns without new file activity.
        // If stalled, inject re-grounding — don't terminate.
        const currentFilesRead = tracker.getReads().length;
        const currentFilesWritten = tracker.getWrites().length;
        const hasActivity = hasNewFileActivity(lastFilesRead, lastFilesWritten, currentFilesRead, currentFilesWritten);
        if (hasActivity) {
          stallTurnCounter = 0;
          lastFilesRead = currentFilesRead;
          lastFilesWritten = currentFilesWritten;
        } else {
          stallTurnCounter++;
          if (stallTurnCounter >= STALL_DETECTION_TURNS) {
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
              turn: currentResult.state.usage.requests,
              contentLengthChars: reground.length,
            });
            if (canAffordNextTurn()) {
            const regroundCont = await runContinuationTurn(currentResult, reground);
              if (regroundCont.ok) {
                currentResult = regroundCont.result;
                stallTurnCounter = 0;
                continue;
              }
            }
          }
        }

        // Degenerate. Apply same-output early-out (only when we have a
        // prior degenerate output to compare against) and retry budget.
        // Only count as degenerate when worker has NO tool calls in this turn.
        if (lastDegenerateOutput !== null && sameDegenerateOutput(stripped, lastDegenerateOutput)) break;
        lastDegenerateOutput = stripped;
        // Only increment degenerate retries when no tool calls were made this turn.
        // If the worker is still calling tools, it's making progress even if the
        // output text is incomplete.
        if (!hasCompletedWork(tracker.getToolCalls())) {
          degenerateRetries++;
          if (degenerateRetries >= MAX_DEGENERATE_RETRIES) break;
        }

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
        if (!canAffordNextTurn()) {
          const costExceeded = buildCostExceededResult(currentResult.state.usage.requests);
          emit({ kind: 'done', status: costExceeded.status });
          return costExceeded;
        }
        const rePromptCont = await runContinuationTurn(currentResult, rePrompt);
        if (!rePromptCont.ok) {
          supervisionExhausted = true;
          break;
        }
        currentResult = rePromptCont.result;

        // --- Periodic re-grounding ---
        const turnsSoFar = currentResult.state.usage.requests;
        if (turnsSoFar > 0 && turnsSoFar % RE_GROUNDING_INTERVAL_TURNS === 0) {
          if (!canAffordNextTurn()) {
            const costExceeded = buildCostExceededResult(currentResult.state.usage.requests);
            emit({ kind: 'done', status: costExceeded.status });
            return costExceeded;
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
            turn: currentResult.state.usage.requests,
            contentLengthChars: reground.length,
          });
          if (!canAffordNextTurn()) {
            const costExceeded = buildCostExceededResult(currentResult.state.usage.requests);
            emit({ kind: 'done', status: costExceeded.status });
            return costExceeded;
          }
          const regroundCont = await runContinuationTurn(currentResult, reground);
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
        : `supervision loop exhausted after ${degenerateRetries} degenerate retries without tool calls (last kind: ${lastValidationKind ?? 'unknown'})`;
      const exhausted = buildSupervisionExhaustedResult(
        currentResult,
        scratchpad,
        tracker,
        runner.providerConfig,
        Date.now() - taskStartMs,
        parentModel,
        { reason: exhaustedReason },
      );
      emit({ kind: 'done', status: exhausted.status });
      return exhausted;
    } catch (err) {
      if (err instanceof MaxTurnsExceededError) {
        // MaxTurnsExceededError from the SDK: map to incomplete with degenerate_exhausted.
        // Prefer scratchpad salvage over the bare diagnostic.
        // Preserve whatever partial usage we accumulated in the last
        // successful agentRun so the caller sees real numbers, not zeros.
        const filesRead = tracker.getReads();
        const filesWritten = tracker.getWrites();
        const toolCalls = tracker.getToolCalls();
        const partial = partialUsage(currentResult, runner.providerConfig, parentModel, runner.usageAccumulator);
        emit({ kind: 'done', status: 'incomplete' });
        const hasSalvage = !scratchpad.isEmpty();
        const turnsAtFailure = currentResult?.state.usage.requests ?? 0;
        return {
          output: hasSalvage
            ? scratchpad.latest()
            : `Agent exceeded time or cost limits.`,
          status: 'incomplete',
          errorCode: 'degenerate_exhausted',
          error: `agent exhausted time/cost budget after ${turnsAtFailure} turns`,
          usage: partial,
          turns: turnsAtFailure,
          filesRead,
          directoriesListed: tracker.getDirectoriesListed(),
          filesWritten,
          toolCalls,
          outputIsDiagnostic: !hasSalvage,
          escalationLog: [],
          durationMs: Date.now() - taskStartMs,
          parsedFindings: null,
        };
      }

      if (err instanceof Error && '__timeCeiling' in err) {
        const ceilingMs = (err as Record<string, unknown>).__timeCeiling as number;
        emit({ kind: 'done', status: 'incomplete' });
        const partial = partialUsage(currentResult, runner.providerConfig, parentModel, runner.usageAccumulator);
        return sharedBuildTimeCeilingResult({
          usage: { inputTokens: partial.inputTokens, outputTokens: partial.outputTokens, totalTokens: partial.totalTokens, costUSD: partial.costUSD, costDeltaVsParentUSD: partial.costDeltaVsParentUSD ?? null, cachedTokens: partial.cachedTokens ?? null, reasoningTokens: partial.reasoningTokens ?? null },
          turns: currentResult?.state.usage.requests ?? 0,
          tracker,
          scratchpad,
          wallClockMs: ceilingMs,
          timeoutMs,
          durationMs: Date.now() - taskStartMs,
        });
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
      const partial = partialUsage(currentResult, runner.providerConfig, parentModel, runner.usageAccumulator);
      return {
        output: hasSalvage ? scratchpad.latest() : `Sub-agent error: ${msg}`,
        status,
        usage: partial,
        turns: currentResult?.state.usage.requests ?? 0,
        filesRead: tracker.getReads(),
        directoriesListed: tracker.getDirectoriesListed(),
        filesWritten: tracker.getWrites(),
        toolCalls: tracker.getToolCalls(),
        outputIsDiagnostic: !hasSalvage,
        escalationLog: [],
        error: msg || reason,
        durationMs: Date.now() - taskStartMs,
        ...(isRateLimit(err) && {
          structuredError: { code: 'rate_limit_exceeded', message: 'rate limited by provider', where: 'runner:openai-compatible' },
        }),
        ...(isProviderContextLimit(err) && {
          errorCode: 'provider_context_limit',
        }),
        parsedFindings: null,
      };
    }
  };

  return withTimeout(
    run(),
    timeoutMs,
    () => {
      emit({ kind: 'done', status: 'timeout' });
      const hasSalvage = !scratchpad.isEmpty();
      const partial = partialUsage(currentResult, runner.providerConfig, parentModel, runner.usageAccumulator);
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
        usage: partial,
        turns: currentResult?.state.usage.requests ?? 0,
        outputIsDiagnostic: !hasSalvage,
        escalationLog: [],
        durationMs: Date.now() - taskStartMs,
        parsedFindings: null,
      };
    },
    abortController,
    options.abortSignal,
  );
}

// --- Helpers: canonical return-shape builders -------------------------------

function resolveProviderRateCard(config: ProviderConfig): RateCard | null {
  return resolveRateCard(config.model, {
    inputCostPerMTok: config.inputCostPerMTok,
    outputCostPerMTok: config.outputCostPerMTok,
  });
}

/**
 * Sum cached_tokens across inputTokensDetails records.
 * OpenAI exposes cache reads only via `cached_tokens` in inputTokensDetails;
 * there is no cache creation exposure.
 */
function sumCachedReadTokens(details?: Array<Record<string, number>>): number | null {
  if (!details || details.length === 0) return null;
  let sum = 0;
  let hasAny = false;
  for (const d of details) {
    if (typeof d.cached_tokens === 'number') {
      sum += d.cached_tokens;
      hasAny = true;
    }
  }
  return hasAny ? sum : null;
}

/**
 * Sum reasoning_tokens across outputTokensDetails records.
 */
function sumReasoningTokens(details?: Array<Record<string, number>>): number | null {
  if (!details || details.length === 0) return null;
  let sum = 0;
  let hasAny = false;
  for (const d of details) {
    if (typeof d.reasoning_tokens === 'number') {
      sum += d.reasoning_tokens;
      hasAny = true;
    }
  }
  return hasAny ? sum : null;
}

/**
 * Extract split cache/reasoning tokens into {@link CanonicalUsage} shape (§3.6).
 *
 * OpenAI exposes cache reads via `cached_tokens` in `inputTokensDetails` and
 * reasoning tokens via `reasoning_tokens` in `outputTokensDetails`. There is
 * no cache creation dimension in OpenAI's API, so `cachedCreationTokens` is
 * always null.
 */
function extractCanonicalTokens(usage: {
  inputTokensDetails?: Array<Record<string, number>>;
  outputTokensDetails?: Array<Record<string, number>>;
}): Pick<CanonicalUsage, 'cachedReadTokens' | 'cachedCreationTokens' | 'reasoningTokens'> {
  return {
    cachedReadTokens: sumCachedReadTokens(usage.inputTokensDetails),
    cachedCreationTokens: null,
    reasoningTokens: sumReasoningTokens(usage.outputTokensDetails),
  };
}

export function openAIUsage(
  currentResult: AgentRunOutput,
  providerConfig: ProviderConfig,
  parentModel?: string,
  usageAccumulator?: import('./openai-usage-interceptor.js').UsageAccumulator,
): SharedResultUsage {
  const sdk = currentResult.state.usage;
  const sdkExtra = extractCanonicalTokens(sdk);
  // SDK fallback path. Use the HTTP-level accumulator (if present) when
  // the SDK reports zero input tokens despite at least one completed
  // request — the @openai/agents stream consumer is known to drop usage
  // on multi-turn DeepSeek calls. Trust SDK numbers when they're present
  // (OpenAI proper) so we don't double-count or lose details the
  // accumulator can't see (e.g. reasoning tokens for o1-style models).
  const sdkLooksDropped = sdk.inputTokens === 0
    && sdk.outputTokens === 0
    && sdk.requests > 0
    && (usageAccumulator?.hasObservedUsage() ?? false);
  let inputTokensRaw: number;
  let outputTokens: number;
  let cachedRead: number;
  let reasoning: number;
  if (sdkLooksDropped) {
    const snap = usageAccumulator!.snapshot();
    inputTokensRaw = snap.promptTokens;
    outputTokens = snap.completionTokens;
    cachedRead = snap.cachedReadTokens;
    reasoning = snap.reasoningTokens;
  } else {
    inputTokensRaw = sdk.inputTokens;
    outputTokens = sdk.outputTokens;
    cachedRead = sdkExtra.cachedReadTokens ?? 0;
    reasoning = sdkExtra.reasoningTokens ?? 0;
  }
  const nonCachedInput = Math.max(0, inputTokensRaw - cachedRead);
  const workerCard = resolveProviderRateCard(providerConfig);
  const tokenCounts: TokenCounts = {
    inputTokens: nonCachedInput,
    outputTokens,
    cachedReadTokens: cachedRead,
    cachedCreationTokens: 0,
    reasoningTokens: reasoning,
  };
  const costUSD = workerCard ? priceTokens(tokenCounts, workerCard) : null;
  let costDeltaVsParentUSD: number | null = null;
  if (costUSD !== null && parentModel) {
    const parentCard = resolveRateCard(parentModel);
    if (parentCard) {
      costDeltaVsParentUSD = costUSD - priceTokens(tokenCounts, parentCard);
    }
  }
  const totalTokens = inputTokensRaw + outputTokens;
  const legacyCached = sdkExtra.cachedReadTokens !== null || sdkLooksDropped ? cachedRead : null;
  return {
    inputTokens: inputTokensRaw,
    outputTokens,
    totalTokens,
    costUSD,
    costDeltaVsParentUSD,
    cachedTokens: legacyCached,
    cachedReadTokens: sdkLooksDropped ? cachedRead : sdkExtra.cachedReadTokens,
    cachedCreationTokens: null,
    reasoningTokens: sdkLooksDropped ? reasoning : sdkExtra.reasoningTokens,
  };
}

function buildOkResult(
  output: string,
  currentResult: AgentRunOutput,
  tracker: FileTracker,
  providerConfig: ProviderConfig,
  durationMs: number,
  parentModel?: string,
  usageAccumulator?: import('./openai-usage-interceptor.js').UsageAccumulator,
): RunResult {
  return sharedBuildOkResult({
    output,
    usage: openAIUsage(currentResult, providerConfig, parentModel, usageAccumulator),
    turns: currentResult.state.usage.requests,
    tracker,
    durationMs,
  });
}

function buildSupervisionExhaustedResult(
  currentResult: AgentRunOutput,
  scratchpad: TextScratchpad,
  tracker: FileTracker,
  providerConfig: ProviderConfig,
  durationMs: number,
  parentModel?: string,
  opts?: { reason?: string },
  usageAccumulator?: import('./openai-usage-interceptor.js').UsageAccumulator,
): RunResult {
  return sharedBuildIncompleteResult({
    usage: openAIUsage(currentResult, providerConfig, parentModel, usageAccumulator),
    turns: currentResult.state.usage.requests,
    tracker,
    scratchpad,
    buildDiagnostic: (ctx) => buildIncompleteDiagnostic({ providerLabel: 'openai-compatible', ...ctx }),
    durationMs,
    reason: opts?.reason,
    stampExhausted: true,
  });
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
  parentModel?: string,
  usageAccumulator?: import('./openai-usage-interceptor.js').UsageAccumulator,
): RunResult['usage'] {
  if (!result) {
    // No SDK result yet — but if the HTTP interceptor saw at least one
    // response, surface that as the partial. Otherwise zeros.
    if (usageAccumulator?.hasObservedUsage()) {
      const snap = usageAccumulator.snapshot();
      const tc: TokenCounts = {
        inputTokens: Math.max(0, snap.promptTokens - snap.cachedReadTokens),
        outputTokens: snap.completionTokens,
        cachedReadTokens: snap.cachedReadTokens,
        cachedCreationTokens: 0,
        reasoningTokens: snap.reasoningTokens,
      };
      const card = resolveProviderRateCard(providerConfig);
      const costUSD = card ? priceTokens(tc, card) : null;
      const parentCard = parentModel ? resolveRateCard(parentModel) : null;
      const costDeltaVsParentUSD = (costUSD !== null && parentCard)
        ? costUSD - priceTokens(tc, parentCard)
        : null;
      return {
        inputTokens: snap.promptTokens,
        outputTokens: snap.completionTokens,
        totalTokens: snap.promptTokens + snap.completionTokens,
        costUSD,
        costDeltaVsParentUSD,
        cachedTokens: snap.cachedReadTokens || null,
        cachedReadTokens: snap.cachedReadTokens || null,
        cachedCreationTokens: null,
        reasoningTokens: snap.reasoningTokens || null,
      };
    }
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null, costDeltaVsParentUSD: null, cachedTokens: null, cachedReadTokens: null, cachedCreationTokens: null, reasoningTokens: null };
  }
  // Reuse openAIUsage's SDK-vs-accumulator selection logic so the timeout
  // / cost-exceeded paths get the same fallback semantics as the ok path.
  return openAIUsage(result, providerConfig, parentModel, usageAccumulator);
}

/**
 * Review-mode entry: routes `systemPrefix` into Agent.instructions
 * (cacheable by OpenAI's prefix-caching rules for instructions > 1024 tokens)
 * and `userBody` as the first user message. The standard prevention-layer
 * system prompt is prepended to instructions.
 */
export async function runOpenAIReview(
  parts: ReviewPromptParts,
  options: ReviewRunOptions,
  runner: OpenAIRunnerOptions,
): Promise<RunResult> {
  return runOpenAI(parts.userBody, {
    ...options,
    instructionsSuffix: parts.systemPrefix,
  }, runner);
}
