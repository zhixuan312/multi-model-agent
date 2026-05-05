import OpenAI from 'openai';
import type { RunnerAdapter, AdapterTurnInput, AdapterTurnResult } from './runner-adapter.js';

export class OpenAIResponsesAdapter implements RunnerAdapter {
  readonly providerType = 'codex' as const;
  private client: OpenAI;
  private model: string;
  private maxOutputTokens: number;

  constructor(opts: { apiKey: string; baseURL?: string; model: string; maxOutputTokens: number }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.model = opts.model;
    this.maxOutputTokens = opts.maxOutputTokens;
  }

  async turn(input: AdapterTurnInput): Promise<AdapterTurnResult> {
    const inputItems = this.buildInputItems(input);

    const response = await this.client.responses.create({
      model: this.model,
      instructions: input.systemPrompt,
      input: inputItems as any,
      tools: input.toolDefinitions.length > 0
        ? input.toolDefinitions.map(d => ({
            type: 'function' as const,
            name: d.name,
            description: d.description,
            parameters: d.schema as Record<string, unknown>,
            strict: false,
          }))
        : undefined,
      max_output_tokens: this.maxOutputTokens,
    });

    const reasoning = (response.usage as any)?.output_tokens_details?.reasoning_tokens ?? 0;
    const usage = {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: (response.usage?.output_tokens ?? 0) + reasoning,
      cachedReadTokens: (response.usage as any)?.input_tokens_details?.cached_tokens ?? 0,
      cachedNonReadTokens: 0,
    };

    const outputItems = (response.output ?? []) as any[];
    const assistantText = outputItems
      .filter((it: any) => it.type === 'message')
      .flatMap((it: any) => it.content ?? [])
      .filter((c: any) => c.type === 'output_text')
      .map((c: any) => c.text)
      .join('');

    const toolCalls = outputItems
      .filter((it: any) => it.type === 'function_call')
      .map((it: any) => {
        let inputObj: unknown;
        try {
          inputObj = JSON.parse(it.arguments ?? '{}');
        } catch (e) {
          inputObj = {
            __mma_invalid_arguments: it.arguments,
            __mma_parse_error: (e as Error).message,
          };
        }
        return {
          id: it.call_id,
          name: it.name,
          input: inputObj,
        };
      });

    // Compute finishReason: the Responses API uses response.status.
    // 'completed' means the model produced a final response (stop).
    // If there are tool calls, the model is waiting for tool outputs.
    const status = response.status as string;
    let finishReason: AdapterTurnResult['finishReason'];
    if (toolCalls.length > 0) {
      finishReason = 'tool_use';
    } else if (status === 'completed') {
      finishReason = 'stop';
    } else if (status === 'incomplete' || status === 'cancelled') {
      finishReason = 'max_tokens';
    } else {
      finishReason = 'error';
    }

    return { assistantText, toolCalls, usage, finishReason };
  }

  private buildInputItems(input: AdapterTurnInput): any[] {
    const items: any[] = [];

    for (const t of input.priorTurns) {
      // Assistant message with text content
      items.push({ role: 'assistant', content: t.assistantText });

      // Each tool call + its result as a function_call / function_call_output pair.
      // The Responses API requires both items so the model can see its tool history.
      for (let ci = 0; ci < t.toolCalls.length; ci++) {
        const c = t.toolCalls[ci];
        const callId = (c as any).id ?? `call_${input.priorTurns.indexOf(t)}_${ci}`;
        items.push({
          type: 'function_call',
          call_id: callId,
          name: c.name,
          arguments: JSON.stringify(c.input),
        });
        items.push({
          type: 'function_call_output',
          call_id: callId,
          output: typeof c.result === 'string' ? c.result : JSON.stringify(c.result ?? null),
        });
      }
    }

    // Current user message
    items.push({ role: 'user', content: input.userMessage });

    return items;
  }
}
