import OpenAI from 'openai';
import type { RunnerAdapter, AdapterTurnInput, AdapterTurnResult } from './runner-adapter.js';

export class OpenAIChatAdapter implements RunnerAdapter {
  readonly providerType: 'openai' | 'openai-compatible';
  private client: OpenAI;
  private model: string;
  private maxOutputTokens: number;

  constructor(opts: {
    apiKey: string;
    baseURL?: string;
    model: string;
    maxOutputTokens: number;
    providerType?: 'openai' | 'openai-compatible';
  }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.providerType = opts.providerType ?? 'openai';
    this.model = opts.model;
    this.maxOutputTokens = opts.maxOutputTokens;
  }

  async turn(input: AdapterTurnInput): Promise<AdapterTurnResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        ...this.priorToMessages(input.priorTurns),
        { role: 'user', content: input.userMessage },
      ],
      tools: input.toolDefinitions.map(d => ({
        type: 'function' as const,
        function: { name: d.name, description: d.description, parameters: d.schema as Record<string, unknown> },
      })),
      max_completion_tokens: this.maxOutputTokens,
    });

    const reasoning = (response.usage as any)?.completion_tokens_details?.reasoning_tokens ?? 0;
    const usage = {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: (response.usage?.completion_tokens ?? 0) + reasoning,
      cachedReadTokens: (response.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0,
      cachedNonReadTokens: 0,
    };

    const choice = response.choices[0];
    if (!choice) {
      return {
        assistantText: '',
        toolCalls: [],
        usage,
        finishReason: 'error',
        errorCode: 'empty_choices',
      };
    }

    // OpenAI v6: ChatCompletionMessageToolCall = FunctionToolCall | CustomToolCall.
    // We only send type:'function' tools, so every response call carries .function.
    const toolCalls = (choice.message.tool_calls ?? []).map(c => {
      const fn = (c as any).function as { name: string; arguments: string } | undefined;
      let input: unknown;
      if (fn) {
        try {
          input = JSON.parse(fn.arguments);
        } catch (e) {
          input = { __mma_invalid_arguments: fn.arguments, __mma_parse_error: (e as Error).message };
        }
      }
      return { id: c.id, name: fn?.name ?? c.type, input };
    });

    return {
      assistantText: choice.message.content ?? '',
      toolCalls,
      usage,
      finishReason: toolCalls.length > 0
        ? 'tool_use'
        : (choice.finish_reason === 'stop' ? 'stop' : 'max_tokens'),
    };
  }

  private priorToMessages(priors: AdapterTurnInput['priorTurns']): any[] {
    return priors.flatMap((t, turnIdx) => [
      {
        role: 'assistant' as const,
        content: t.assistantText || null,
        tool_calls: t.toolCalls.map((c, callIdx) => ({
          id: (c as any).id ?? `call_${turnIdx}_${callIdx}`,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      },
      ...t.toolCalls.map((c, callIdx) => ({
        role: 'tool' as const,
        tool_call_id: (c as any).id ?? `call_${turnIdx}_${callIdx}`,
        content: typeof c.result === 'string' ? c.result : JSON.stringify(c.result ?? null),
      })),
    ]);
  }
}
