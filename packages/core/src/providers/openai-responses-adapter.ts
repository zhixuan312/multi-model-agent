import OpenAI from 'openai';
import type { RunnerAdapter, AdapterTurnInput, AdapterTurnResult } from './runner-adapter.js';

export class OpenAIResponsesAdapter implements RunnerAdapter {
  readonly providerType = 'codex' as const;
  private client: OpenAI;
  private model: string;

  constructor(opts: { apiKey: string; baseURL?: string; model: string; defaultHeaders?: Record<string, string> }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      ...(opts.defaultHeaders && { defaultHeaders: opts.defaultHeaders }),
    });
    this.model = opts.model;
  }

  async turn(input: AdapterTurnInput): Promise<AdapterTurnResult> {
    const inputItems = this.buildInputItems(input);

    // Stream the response. Two reasons:
    //   1. The chatgpt.com/backend-api/codex endpoint (used when codex
    //      OAuth is the auth path) only accepts streaming + store:false;
    //      a non-streaming responses.create returns 400-no-body there.
    //   2. api.openai.com supports streaming the same shape, so streaming
    //      is the universal path.
    // store:false tells the server not to persist response state — required
    // by chatgpt backend, harmless for api.openai.com.
    const stream = await this.client.responses.create({
      model: this.model,
      instructions: input.systemPrompt,
      input: inputItems as any,
      stream: true,
      store: false,
      tools: input.toolDefinitions.length > 0
        ? input.toolDefinitions.map(d => ({
            type: 'function' as const,
            name: d.name,
            description: d.description,
            parameters: d.schema as Record<string, unknown>,
            strict: false,
          }))
        : undefined,
    });

    let assistantText = '';
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedReadTokens = 0;
    let reasoningTokens = 0;
    let status: string | undefined;
    let sawCompleted = false;

    for await (const event of stream as any) {
      const et = event?.type as string | undefined;
      if (!et) continue;

      if (et === 'response.output_text.delta') {
        assistantText += event.delta ?? '';
      } else if (et === 'response.output_item.done') {
        const item = event.item;
        if (item?.type === 'function_call') {
          let inputObj: unknown;
          try {
            inputObj = JSON.parse(item.arguments ?? '{}');
          } catch (e) {
            inputObj = {
              __mma_invalid_arguments: item.arguments,
              __mma_parse_error: (e as Error).message,
            };
          }
          toolCalls.push({ id: item.call_id, name: item.name, input: inputObj });
        }
      } else if (et === 'response.completed') {
        sawCompleted = true;
        const r = event.response;
        if (r?.usage) {
          const u = r.usage as Record<string, any>;
          inputTokens = u.input_tokens ?? 0;
          outputTokens = u.output_tokens ?? 0;
          reasoningTokens = u.output_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0;
          cachedReadTokens = u.input_tokens_details?.cached_tokens ?? u.cached_input_tokens ?? 0;
        }
        if (r?.status) status = r.status;
      }
    }

    if (!sawCompleted) {
      throw new Error('Codex stream ended without a response.completed event');
    }

    const usage = {
      inputTokens,
      outputTokens: outputTokens + reasoningTokens,
      cachedReadTokens,
      cachedNonReadTokens: 0,
    };

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
