import Anthropic from '@anthropic-ai/sdk';
import type { RunnerAdapter, AdapterTurnInput, AdapterTurnResult } from './runner-adapter.js';

export class AnthropicMessagesAdapter implements RunnerAdapter {
  readonly providerType: 'claude' | 'claude-compatible';
  private client: Anthropic;
  private model: string;
  private maxOutputTokens: number;

  constructor(opts: {
    apiKey: string;
    baseURL?: string;
    model: string;
    maxOutputTokens: number;
    providerType?: 'claude' | 'claude-compatible';
  }) {
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.providerType = opts.providerType ?? 'claude';
    this.model = opts.model;
    this.maxOutputTokens = opts.maxOutputTokens;
  }

  async turn(input: AdapterTurnInput): Promise<AdapterTurnResult> {
    const messages = this.buildMessages(input);
    const response = await this.client.messages.create({
      model: this.model,
      system: input.systemPrompt,
      messages,
      tools: this.mapTools(input.toolDefinitions),
      max_tokens: this.maxOutputTokens,
    });

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cachedReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cachedNonReadTokens: response.usage.cache_creation_input_tokens ?? 0,
    };

    const text = response.content.filter(b => b.type === 'text').map((b: any) => b.text).join('');
    const toolCalls = response.content
      .filter(b => b.type === 'tool_use')
      .map((b: any) => ({ id: b.id, name: b.name, input: b.input }));

    return {
      assistantText: text,
      toolCalls,
      usage,
      finishReason: toolCalls.length > 0 ? 'tool_use' : (response.stop_reason === 'end_turn' ? 'stop' : 'max_tokens'),
    };
  }

  private buildMessages(input: AdapterTurnInput): any[] {
    const out: any[] = [];
    for (const t of input.priorTurns) {
      const assistantBlocks: any[] = [];
      if (t.assistantText) assistantBlocks.push({ type: 'text', text: t.assistantText });

      // Generate deterministic IDs so tool_use and tool_result blocks match.
      // AdapterTurnRecord.toolCalls does not carry id, but Anthropic Messages
      // requires tool_use_id on tool_result blocks to echo the tool_use block id.
      const toolUseIds = t.toolCalls.map((_, ci) =>
        `toolu_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`,
      );

      for (let ci = 0; ci < t.toolCalls.length; ci++) {
        const c = t.toolCalls[ci];
        assistantBlocks.push({
          type: 'tool_use',
          id: toolUseIds[ci],
          name: c.name,
          input: c.input,
        });
      }
      if (assistantBlocks.length > 0) out.push({ role: 'assistant', content: assistantBlocks });

      const toolResultBlocks = t.toolCalls
        .filter(c => 'result' in c)
        .map((c, ci) => ({
          type: 'tool_result',
          tool_use_id: toolUseIds[ci],
          content: typeof c.result === 'string' ? c.result : JSON.stringify(c.result ?? null),
        }));
      if (toolResultBlocks.length > 0) out.push({ role: 'user', content: toolResultBlocks });
    }
    out.push({ role: 'user', content: input.userMessage });
    return out;
  }

  private mapTools(defs: AdapterTurnInput['toolDefinitions']) {
    return defs.map(d => ({
      name: d.name,
      description: d.description,
      input_schema: d.schema as { type: 'object'; properties: Record<string, unknown>; required?: string[] },
    }));
  }
}
