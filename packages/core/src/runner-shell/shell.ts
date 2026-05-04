import type { RunInput, RunResult, ExecutionContext } from './types.js';
import type { RunnerAdapter, AdapterTurnResult, AdapterCapabilities } from './adapter.js';

const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [],
};

type AdapterTurnRecord = {
  assistantText: string;
  toolCalls: Array<{ name: string; input: unknown; result?: unknown; id?: string }>;
};

export class RunnerShell {
  constructor(private adapter: RunnerAdapter) {}

  async run(input: RunInput): Promise<RunResult> {
    const ctx: ExecutionContext = { cwd: input.cwd, callCache: new Map() };
    const usage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 };
    const allToolCalls: Array<{ name: string; input: unknown; result?: unknown; id?: string }> = [];
    const history: AdapterTurnRecord[] = [];
    let finalText = '';
    let stoppedByAdapter = false;

    for (let turn = 0; turn < input.maxTurns; turn++) {
      const turnResult: AdapterTurnResult = await this.adapter.turn({
        systemPrompt: input.systemPrompt,
        userMessage: input.userMessage,
        priorTurns: history,
        toolDefinitions: input.toolDefinitions,
        capabilities: input.capabilities ?? DEFAULT_CAPABILITIES,
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
        let enriched: AdapterTurnRecord['toolCalls'][number];
        if (!def) {
          enriched = { ...call, result: { error: `unknown tool: ${call.name}` } };
        } else {
          try {
            enriched = { ...call, result: await def.execute(call.input, ctx) };
          } catch (err) {
            enriched = { ...call, result: { error: `tool execution failed: ${err instanceof Error ? err.message : String(err)}` } };
          }
        }
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
