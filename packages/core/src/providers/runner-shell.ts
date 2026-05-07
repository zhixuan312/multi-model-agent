import type { RunInput, RunResult, ExecutionContext, ToolCall } from './runner-shell-types.js';
import type { RunnerAdapter, AdapterTurnResult, AdapterTurnRecord, AdapterCapabilities } from './runner-adapter.js';
import { resolveRateCard, priceTokens } from '../bounded-execution/cost-compute.js';

const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [],
};

// Tool name lookup tables for filesRead/filesWritten attribution. Tools come
// from different adapters under different snake/camel spellings; treat them
// as one set so a worker that called `read_file` once shows
// filesReadCount=1 regardless of which casing the adapter normalized to.
const READ_TOOL_NAMES = new Set(['readFile', 'read_file']);
const WRITE_TOOL_NAMES = new Set(['writeFile', 'write_file', 'editFile', 'edit_file']);

function extractPathFromToolInput(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'filePath']) {
    const v = obj[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

export class RunnerShell {
  constructor(
    private adapter: RunnerAdapter,
    /** Default model id used for cost computation when input.model is absent.
     *  Reviewer/annotator engines call shell.run() without setting input.model,
     *  so without this default every reviewer-side stage would record costUSD=null. */
    private defaultModel?: string,
  ) {}

  async run(input: RunInput): Promise<RunResult> {
    const startMs = Date.now();
    const modelForCost = input.model ?? this.defaultModel;
    const ctx: ExecutionContext = { cwd: input.cwd, callCache: new Map() };
    const usage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 };
    const allToolCalls: ToolCall[] = [];
    const filesRead: string[] = [];
    const filesWritten: string[] = [];
    let turns = 0;
    const history: AdapterTurnRecord[] = [];
    let finalText = '';
    let stoppedByAdapter = false;

    // Common fields stamped on every emitted bus event so VerboseLogChannel
    // surfaces enough context for an operator to see which run a line belongs
    // to without grepping back to the originating request.
    const baseEventFields = {
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
      ...(input.tier !== undefined && { tier: input.tier }),
      ...(input.model !== undefined && { model: input.model }),
      ...(input.stageLabel !== undefined && { stageLabel: input.stageLabel }),
      providerType: this.adapter.providerType,
    };

    for (let turn = 0; turn < input.maxTurns; turn++) {
      if (input.abortSignal?.aborted) {
        return {
          workerStatus: 'blocked',
          finalAssistantText: '',
          toolCalls: allToolCalls,
          usage,
          errorCode: 'aborted',
          turns,
          durationMs: Date.now() - startMs,
          filesRead,
          filesWritten,
          costUSD: computeCost(modelForCost, usage),
        };
      }

      // Three-event-per-turn lifecycle so verbose stderr surfaces every
      // state change. `runner_turn_started` fires before the LLM call so
      // operators see "now waiting on the model" in real time. After the
      // adapter returns, `runner_response_received` carries the raw
      // provider response shape (stop_reason + content-block tally). After
      // local tool execution, `runner_turn_completed` carries per-tool
      // counts (read vs write etc.) so operators can see what work the
      // model is doing without grepping the JSONL log.
      input.bus?.emit({
        event: 'runner_turn_started',
        ts: new Date().toISOString(),
        ...baseEventFields,
        turnIndex: turn,
      });
      turns++;

      const turnResult: AdapterTurnResult = await this.adapter.turn({
        systemPrompt: input.systemPrompt,
        userMessage: input.userMessage,
        priorTurns: history,
        toolDefinitions: input.toolDefinitions,
        capabilities: input.capabilities ?? DEFAULT_CAPABILITIES,
        abortSignal: input.abortSignal,
        deadlineMs: input.deadlineMs,
      });

      usage.inputTokens += turnResult.usage.inputTokens;
      usage.outputTokens += turnResult.usage.outputTokens;
      usage.cachedReadTokens += turnResult.usage.cachedReadTokens;
      usage.cachedNonReadTokens += turnResult.usage.cachedNonReadTokens;

      finalText = turnResult.assistantText;

      input.bus?.emit({
        event: 'runner_response_received',
        ts: new Date().toISOString(),
        ...baseEventFields,
        turnIndex: turn,
        finishReason: turnResult.finishReason,
        assistantTextLen: turnResult.assistantText.length,
        toolCallCount: turnResult.toolCalls.length,
        ...(turnResult.responseShape?.stopReason !== undefined && { stopReason: turnResult.responseShape.stopReason }),
        ...(turnResult.responseShape?.contentBlocks !== undefined && { contentBlocks: turnResult.responseShape.contentBlocks }),
        usage: turnResult.usage,
      });

      const turnRecord: AdapterTurnRecord = {
        assistantText: turnResult.assistantText,
        toolCalls: [],
      };

      const willTerminate = turnResult.toolCalls.length === 0;
      if (willTerminate) {
        history.push(turnRecord);
        stoppedByAdapter = true;
      } else {
        for (const call of turnResult.toolCalls) {
          const def = input.toolDefinitions.find(d => d.name === call.name);
          let result: unknown;
          if (!def) {
            result = { error: `unknown tool: ${call.name}` };
          } else {
            try {
              result = await def.execute(call.input, ctx);
            } catch (err) {
              result = { error: `tool execution failed: ${err instanceof Error ? err.message : String(err)}` };
            }
          }
          const enriched = { name: call.name, input: call.input, result };
          allToolCalls.push(enriched);
          turnRecord.toolCalls.push(enriched);
          // Track file ops so the wire telemetry's filesReadCount /
          // filesWrittenCount aren't perpetually 0. Only count successful
          // calls (a tool that threw produced { error: ... } as result).
          const succeeded = !(typeof result === 'object' && result !== null && 'error' in (result as Record<string, unknown>));
          if (succeeded) {
            const path = extractPathFromToolInput(call.input);
            if (READ_TOOL_NAMES.has(call.name) && path) filesRead.push(path);
            else if (WRITE_TOOL_NAMES.has(call.name) && path) filesWritten.push(path);
          }
        }
        history.push(turnRecord);
      }

      // Per-tool counts for THIS turn so operators see "5 readFile, 1 grep"
      // instead of the bare "tool_call_count=6". The user can immediately
      // tell read vs write activity without inspecting the JSONL log.
      const toolCallsByName: Record<string, number> = {};
      for (const tc of turnResult.toolCalls) {
        toolCallsByName[tc.name] = (toolCallsByName[tc.name] ?? 0) + 1;
      }

      input.bus?.emit({
        event: 'runner_turn_completed',
        ts: new Date().toISOString(),
        ...baseEventFields,
        turnIndex: turn,
        terminated: willTerminate,
        toolCallCount: turnResult.toolCalls.length,
        ...(turnResult.toolCalls.length > 0 && { toolCalls: toolCallsByName }),
      });

      if (willTerminate) break;
    }

    // Empty-output regression guard (4.0.3). The 4.0.x runner-shell
    // unconditionally reported `workerStatus: 'done'` whenever the adapter
    // returned no tool calls — even when assistantText was empty. Combined
    // with the anthropic-messages adapter's text-only extraction, a
    // reasoning model that emitted thinking blocks with no text block (or
    // any provider that returned end_turn with empty content) silently
    // produced an "ok" RunResult carrying `output: ''`. The reviewer
    // engine then approved that empty output and the audit/delegate
    // looked successful while emitting nothing useful.
    //
    // 3.12.7's claude-agent-sdk owned the agent loop and didn't have this
    // failure mode. This branch restores the missing check: stopping with
    // empty narrative AND no tool calls is `incomplete`, surfaced as a
    // structured error with errorCode `empty_output` so callers can tell
    // the difference between "model finished cleanly" and "model returned
    // nothing usable".
    if (stoppedByAdapter && finalText.trim() === '' && allToolCalls.length === 0) {
      return {
        workerStatus: 'failed',
        finalAssistantText: '',
        toolCalls: allToolCalls,
        usage,
        errorCode: 'empty_output',
        turns,
        durationMs: Date.now() - startMs,
        filesRead,
        filesWritten,
        costUSD: computeCost(modelForCost, usage),
      };
    }

    return {
      workerStatus: stoppedByAdapter ? 'done' : 'blocked',
      finalAssistantText: finalText,
      toolCalls: allToolCalls,
      usage,
      ...(stoppedByAdapter ? {} : { errorCode: 'max_turns_exhausted' }),
      turns,
      durationMs: Date.now() - startMs,
      filesRead,
      filesWritten,
      costUSD: computeCost(modelForCost, usage),
    };
  }
}

function computeCost(model: string | undefined, usage: { inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedNonReadTokens: number }): number | null {
  const card = resolveRateCard(model ?? null);
  if (!card) return null;
  return priceTokens(usage, card);
}
