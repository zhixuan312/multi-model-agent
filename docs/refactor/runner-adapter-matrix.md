# Runner Adapter Matrix (Chapter 4 Task 24)

This artifact compares the current provider runner implementations and tests whether a small `RunnerAdapter<ProviderTurn, ProviderUsage>` can normalize their mechanics without hiding provider behavior that should remain explicit.

Source files reviewed:

- `packages/core/src/runners/openai-runner.ts`
- `packages/core/src/runners/claude-runner.ts`
- `packages/core/src/runners/codex-runner.ts`
- `docs/superpowers/plans/2026-04-24-internal-refactor-plan.md` lines 1720-1770

## Matrix

| Concern | OpenAI | Claude | Codex | Shared? |
|---|---|---|---|---|
| Turn loop model | One initial `agentRun(agent, promptWithBudgetHint, { maxTurns: Number.MAX_SAFE_INTEGER, signal })`, then a supervision `while (true)` around the completed `AgentRunOutput`. Continuations call `agentRun` again with `continueWith(prev.history, instruction)`. Turn count comes from `currentResult.state.usage.requests`. | Single long-lived `for await (const msg of query({ prompt: messageQueue, options }))` over `claude-agent-sdk`. A `PushableUserMessageQueue` feeds initial prompt plus supervision/re-grounding user messages into the running query. `turns++` on each `msg.type === 'assistant'`; finalization happens on `msg.type === 'result'`. | Explicit `while (true)` in the runner. Each iteration calls `client.responses.create({ stream: true, store: false, input, tools, instructions })`, consumes that stream to completion, executes any function calls, appends function call/output protocol items to `input`, then loops. `turns++` at top of each iteration. | Shared supervision states are similar, but the provider turn driver is divergent: batch run + continuation for OpenAI, async iterator with pushable input for Claude, manual Responses stream loop for Codex. Adapter should own provider turn I/O and expose normalized turn observations. |
| Streaming model | Not truly streamed by this runner. It awaits each `agentRun` result, then extracts assistant text from `result.newItems` of type `message_output_item`, `rawItem.role === 'assistant'`, content parts with `part.type === 'output_text'`. Text is stripped with `stripThinkingTags` and buffered after the call completes. | SDK is consumed as an async iterable of messages. Assistant text is read as it arrives from `msg.message.content`: either a defensive bare string branch or an array filtered to `{ type: 'text', text: string }`; joined with `\n` and appended to scratchpad. Tool-use and thinking blocks are ignored for salvage text. | Required streaming. Runner accumulates `event.delta` from `response.output_text.delta`; observes `response.output_item.added`, `response.output_item.done`, and `response.completed`. Text is appended after the stream ends for the turn; function calls are collected from completed output items. | Partly shared. All can be normalized to `text_emission` plus a completed provider turn, but OpenAI is post-hoc extraction rather than stream events. Interface should not assume token/text deltas are real-time for every provider. |
| Tool-call representation | Tool definitions come from `createOpenAITools(toolImpls, sandboxPolicy, toolMode)` plus optional hosted tools as `{ type: hostedToolName }`. Runtime tool activity is handled inside `@openai/agents`; the runner only observes `FileTracker` callbacks and `RunItem` messages. Tool call items are not manually replayed. | Tools are either MCP server tools from `createClaudeToolServer(...)` under `mcpServers: { 'code-tools': toolServer }` and `allowedTools: ['mcp__code-tools__*']`, or built-ins `WebSearch` and `WebFetch`. SDK message content may include `{ type: 'tool_use', ... }`, but runner does not execute/replay tool calls directly; it observes side effects via `FileTracker`. User messages use `SDKUserMessage` shape `{ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }`. | Local tools are explicit Responses API function tools: `{ type: 'function', name, description, parameters, strict: false }`. A streamed function call item has `{ type: 'function_call', call_id: string, name: string, arguments: string }`; tool output is sent back as `{ type: 'function_call_output', call_id, output }`. Hosted web search defaults to `{ type: 'web_search' }` unless configured. | Divergent. Normalized adapter can expose local tool definitions and normalized completed tool calls, but Codex uniquely requires manual call execution and replay. This is an adapter responsibility, not a shared-loop escape hatch, if the adapter returns `toolCalls` and accepts `appendToolResult`. |
| Usage accounting | SDK usage is `result.state.usage` with exact fields `inputTokens`, `outputTokens`, `totalTokens`, and `requests`. `requests` is also turn count. Partial usage is read from the last successful `AgentRunOutput`; cost is computed with `computeCostUSD(inputTokens, outputTokens, providerConfig)`. | Usage is accumulated across every `msg.type === 'result'`. Preferred field is `msg.modelUsage`, iterating values and summing `model.inputTokens` and `model.outputTokens`. Fallback is `msg.usage` with exact fields `input_tokens` and `output_tokens`. SDK cost may be `msg.total_cost_usd`; `effectiveClaudeCost` uses computed cost first, then SDK cost. | Usage comes from `response.completed` event: `event.response.usage.input_tokens` and `event.response.usage.output_tokens`, accumulated into runner-local `inputTokens`/`outputTokens`. Total is computed as their sum; cost is computed locally with `computeCostUSD`. | Shared after normalization to `{ inputTokens, outputTokens, totalTokens, costUSD }`. Raw SDK fields are highly divergent, so usage extraction belongs in provider adapters. |
| Retry + error semantics | Supervision `while (true)` validates `currentResult.finalOutput ?? ''` after each provider call. Invalid output triggers `buildRePrompt(validation)` continuation unless same-output early-out or `MAX_DEGENERATE_RETRIES` without completed work. Watchdog warning injects budget nudge; periodic/stall/tool-loop re-grounding can inject continuations. `MaxTurnsExceededError` maps to `status: 'incomplete'`, `errorCode: 'degenerate_exhausted'`. Other errors go through `classifyError`. | Retries are driven by result messages in the same async iterator. Invalid `msg.result` pushes `buildRePrompt(validation)` to the queue. Same-output and `MAX_DEGENERATE_RETRIES` produce incomplete. Watchdog warning pushes a budget nudge on assistant cadence; force salvage aborts and closes queue. Errors from `query` go through `classifyError`. | Retries are explicit loop iterations. If a turn has no function calls, `textThisTurn` is validated; invalid output appends a user re-prompt to `input` and continues unless retry/same-output exhausted. Tool calls are executed and their outputs appended before continuing. Stream ending without `response.completed` throws. Catch path enriches OpenAI SDK/API errors and captured raw HTTP details, then classifies with `classifyError`. | Mostly shared policy, divergent delivery mechanism. Shared loop can call adapter methods for `sendUserMessage`/`nextTurn`; provider-specific stream/API error enrichment stays adapter-local. |
| Incomplete / partial / force-salvage paths | Scratchpad buffers assistant text per completed `agentRun`. Incomplete paths include supervision exhausted, continuation `MaxTurnsExceededError`, SDK `MaxTurnsExceededError`, timeout, classified errors, and watchdog `force_salvage`. Partial usage comes from `partialUsage(currentResult, providerConfig)`. Force-salvage diagnostic text includes provider label `openai-compatible`, current input tokens, and soft limit when scratchpad is empty. | Scratchpad buffers assistant text blocks from assistant messages. Incomplete paths include max turns (`msg.subtype === 'error_max_turns'`), supervision exhausted, iterator drained without result, timeout, classified errors, and watchdog force salvage. Partial usage comes from accumulated `inputTokens`/`outputTokens` plus optional `total_cost_usd`. Force-salvage closes queue and aborts. | Scratchpad buffers `textThisTurn`. Incomplete paths include supervision exhausted, loop fallthrough, timeout, classified/enriched errors, and watchdog force salvage. Partial usage comes from accumulated response-completed usage. Force-salvage returns immediately from the loop. | Shared result-building shape is strong: status, usage, turns, tracker data, `outputIsDiagnostic`, salvage preference. Adapter should provide normalized partial state and best salvage text; shared runner shell can build canonical `RunResult`s. |
| Finish-reason enumeration | `@openai/agents` runner does not directly expose or branch on Chat Completions finish reasons here. Terminal conditions are SDK completion, `MaxTurnsExceededError`, validation, timeout, cost ceiling, watchdog, or classified thrown error. Underlying OpenAI-compatible Chat Completions finish reasons may include values such as `stop`, `length`, `tool_calls`, `content_filter`, or provider-specific variants, but this runner does not consume them. | Claude Agent SDK result subtype is consumed only for `msg.subtype === 'error_max_turns'`. The runner otherwise treats a `result` message with valid text as completion. Underlying Anthropic stop reasons such as `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, and `refusal` are not read in this runner. | Responses stream records `event.response.status` from `response.completed` into `lastResponseStatus`; observed/expected Response status strings include `completed`, `failed`, `cancelled`, `incomplete`, and `queued`/`in_progress` during lifecycle, but the runner branches only on seeing `response.completed` and uses status for diagnostics. It does not branch on `finish_reason`. | Needs normalization, but current code mostly does not depend on finish reasons. Adapter can expose optional `finishReason`/`providerStatus` for diagnostics while shared policy remains validation-driven. |
| Provider-specific quirks | Disables tracing globally with `setTracingDisabled(true)` for OpenAI-compatible providers. Uses `OpenAIChatCompletionsModel` from `@openai/agents`. Strips inline `<think>...</think>` blocks and substitutes `THINKING_DIAGNOSTIC_MARKER` if output was only thinking. Turn attribution for tracker uses `(currentResult?.state.usage.requests ?? 0) + 1` because usage request count updates after `agentRun`. Hosted tools are appended only when tools are enabled. | Uses `systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt }` to preserve Claude Code tool guidance. Permission bypass is intentional (`permissionMode: 'bypassPermissions'`, `allowDangerouslySkipPermissions: true`) while filesystem sandbox is enforced in local tools. `persistSession: false`. Built-in `WebSearch`/`WebFetch` are enabled when tools are on. Thinking is disabled for `effort` none, otherwise adaptive. Tracker turn attribution uses current `turns`, not `+1`. | Has custom auth/client path: Codex OAuth via `https://chatgpt.com/backend-api/codex` with `chatgpt-account-id`, or `OPENAI_API_KEY`. Custom fetch captures raw 4xx/5xx response bodies; `CODEX_DEBUG=1` logs sensitive request/response previews with warning. Uses `store: false`, so only function_call items are replayed and server-generated `id` fields are stripped to avoid 404 on non-persisted reasoning/message items. Web search defaults on. | Several quirks must remain provider-local. They do not prevent an adapter if the interface is intentionally shallow and keeps provider setup/stream protocol inside implementations. |
| Initial request hashing and prompt injection | Hashes canonical `${systemPrompt}\n\n${promptWithBudgetHint}` before SDK wrapping. System prompt goes into Agent `instructions`; budget hint prepends first user prompt. Continuation injections are added as user messages via `continueWith(prev.history, instruction)`. | Hashes the same canonical brief even though wire prompt includes `claude_code` preset plus appended system prompt. Initial and injected user messages are queue items. | Hashes the same canonical brief even though wire uses Responses `instructions` and structured `input`. Injections are appended to `input` as user messages. | Shared canonical hashing is already consistent. Adapter should accept normalized initial brief/system/user messages but own wire conversion. |
| Cost ceiling and next-turn affordability | `CostMeter` uses computed per-turn cumulative cost from current result. `lastTurnCostUSD` is estimated from current cumulative usage, so it is conservative/imperfect; `buildCostExceededResult(turnsAtFailure)` uses partial usage. | Per-result turn cost is computed from the result-message delta (`turnInputTokens`, `turnOutputTokens`) and added to `CostMeter`; `total_cost_usd` may be retained as fallback final cost. | Per-turn cost is computed from deltas between start/end accumulated token counters. `buildCostExceededResult` currently coerces null cost to `0` in result usage. | Shared enough after normalized usage deltas. Provider adapters should return both cumulative and delta usage for accurate metering. |

## Proposed `RunnerAdapter<ProviderTurn, ProviderUsage>` interface

The interface should live under `packages/core/src/runners/base/` in Chapter 4. The imports below intentionally use the post-Chapter-3 paths requested by the plan: runner-local types from `../types.js`, cross-cutting types/utilities from `../../types.js`.

```ts
import type {
  InternalRunnerEvent,
  RunOptions,
  RunResult,
} from '../types.js';
import type {
  ProviderConfig,
  SandboxPolicy,
  ToolMode,
} from '../../types.js';
import type { FileTracker } from '../../tools/tracker.js';
import type { ToolImplementations } from '../../tools/definitions.js';

export interface NormalizedProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests?: number;
  costUSD?: number | null;
}

export interface NormalizedProviderToolCall {
  id: string;
  name: string;
  argumentsText: string;
  raw?: unknown;
}

export interface NormalizedProviderTurn<ProviderTurn, ProviderUsage> {
  raw: ProviderTurn;
  text: string;
  usage: ProviderUsage;
  normalizedUsage: NormalizedProviderUsage;
  toolCalls: NormalizedProviderToolCall[];
  finishReason?: string;
  providerStatus?: string;
}

export interface RunnerAdapter<ProviderTurn, ProviderUsage> {
  readonly providerLabel: 'openai-compatible' | 'claude' | 'codex' | string;

  createInitialState(args: {
    promptWithBudgetHint: string;
    systemPrompt: string;
    options: RunOptions;
    providerConfig: ProviderConfig;
    defaults: { timeoutMs: number; tools: ToolMode };
    tracker: FileTracker;
    toolImpls: ToolImplementations;
    sandboxPolicy: SandboxPolicy;
    abortController: AbortController;
    emit: (event: InternalRunnerEvent) => void;
  }): Promise<void> | void;

  nextTurn(): Promise<NormalizedProviderTurn<ProviderTurn, ProviderUsage>>;

  sendUserMessage(text: string): Promise<void> | void;

  executeToolCall?(call: NormalizedProviderToolCall): Promise<string>;

  appendToolResult?(call: NormalizedProviderToolCall, result: string): Promise<void> | void;

  getPartialUsage(): NormalizedProviderUsage;

  abort(reason?: string): Promise<void> | void;
}
```

Notes:

- `nextTurn()` is the main abstraction point. OpenAI implements it by awaiting one `agentRun`; Claude implements it by reading until the next assistant/result boundary from the SDK iterator; Codex implements it by consuming one Responses stream iteration.
- `executeToolCall`/`appendToolResult` are optional because OpenAI and Claude delegate local tool execution to their SDK/MCP integrations, while Codex must execute and replay function calls manually.
- `finishReason` and `providerStatus` are optional diagnostics because the existing runners do not make core decisions from provider finish reasons.
- `raw?: unknown` on normalized tool calls is a diagnostic/adapter-local escape valve for logging and replay construction, not a shared-policy escape hatch.

## Viability verdict

The adapter is viable if it stays shallow: provider adapters should normalize turn observations, text, usage, tool-call replay needs, and abort/partial state, while the shared runner shell owns supervision, scratchpad salvage preference, watchdog policy, cost ceiling checks, result building, and progress events.

Rows that need provider-local handling but not a shared-loop escape hatch:

1. Turn loop model: provider adapters must hide three different I/O drivers.
2. Streaming model: adapters must normalize post-hoc OpenAI extraction, Claude iterator messages, and Codex Responses events.
3. Tool-call representation: Codex requires manual execution/replay; OpenAI and Claude do not.
4. Usage accounting: exact SDK field names are divergent and must be extracted adapter-locally.
5. Provider-specific quirks: setup/auth/prompt wrapping/debug behavior must remain inside adapters.

Rows that would require a provider-specific escape hatch in the shared policy: **0** in the current design. The optional `executeToolCall`/`appendToolResult` methods are provider capability hooks, not arbitrary escape hatches; they are typed, narrow, and directly motivated by Codex's Responses function-call protocol.

Rollback-plan trigger: **not triggered**. Fewer than three rows require provider-specific shared-policy escape hatches. The recommended path is to proceed with a shallow `RunnerAdapter` and avoid forcing a deeper common stream/SDK abstraction.
