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

      if (turnResult.toolCalls.length === 0) {
        history.push(turnRecord);
        stoppedByAdapter = true;
        break;
      }

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

    return {
      workerStatus: stoppedByAdapter ? 'done' : 'blocked',
      finalAssistantText: finalText,
      toolCalls: allToolCalls,
      usage,
      ...(stoppedByAdapter ? {} : { errorCode: 'max_turns_exhausted' }),
    };
  }
}
