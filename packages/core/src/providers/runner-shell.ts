import type { RunInput, RunResult, ExecutionContext, ToolCall } from './runner-shell-types.js';
import type { RunnerAdapter, AdapterTurnResult, AdapterTurnRecord, AdapterCapabilities } from './runner-adapter.js';

const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [],
};

export class RunnerShell {
  constructor(private adapter: RunnerAdapter) {}

  async run(input: RunInput): Promise<RunResult> {
    const ctx: ExecutionContext = { cwd: input.cwd, callCache: new Map() };
    const usage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 };
    const allToolCalls: ToolCall[] = [];
    const history: AdapterTurnRecord[] = [];
    let finalText = '';
    let stoppedByAdapter = false;

    // Common fields stamped on every emitted bus event so VerboseLogChannel
    // surfaces enough context for an operator to see which run a line belongs
    // to without grepping back to the originating request.
    const baseEventFields = {
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.tier !== undefined && { tier: input.tier }),
      ...(input.model !== undefined && { model: input.model }),
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
        };
      }

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
        }
        history.push(turnRecord);
      }

      // One event per turn carrying everything an operator needs to see
      // why a long task is taking so long: turn index, finish reason,
      // assistant-text length (0 → empty content), tool-call count, and
      // (from the adapter) raw stop_reason + content-block-type tally.
      // The content-block tally is the diagnostic that surfaces e.g.
      // `{ text: 0, thinking: 1 }` when deepseek emitted reasoning-only —
      // the failure mode that 4.0.x silently treated as "ok".
      input.bus?.emit({
        event: 'runner_turn_completed',
        ts: new Date().toISOString(),
        ...baseEventFields,
        turnIndex: turn,
        finishReason: turnResult.finishReason,
        assistantTextLen: turnResult.assistantText.length,
        toolCallCount: turnResult.toolCalls.length,
        terminated: willTerminate,
        ...(turnResult.responseShape?.stopReason !== undefined && { stopReason: turnResult.responseShape.stopReason }),
        ...(turnResult.responseShape?.contentBlocks !== undefined && { contentBlocks: turnResult.responseShape.contentBlocks }),
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
      };
    }

    return {
      workerStatus: stoppedByAdapter ? 'done' : 'blocked',
      finalAssistantText: finalText,
      toolCalls: allToolCalls,
      usage,
      ...(stoppedByAdapter ? {} : { errorCode: 'max_turns_exhausted' }),
    };
  }
}
