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
    /** Claude Code subscription OAuth token (4.2.3+). When provided, the
     *  adapter sends `Authorization: Bearer <token>` + the OAuth beta
     *  header instead of the `x-api-key: <apiKey>` header — letting users
     *  with a Claude Max subscription dispatch via mma without an
     *  Anthropic API key. Pulled from macOS Keychain (`security
     *  find-generic-password -s "Claude Code-credentials"`) by
     *  `getClaudeOAuth()` in identity/auth-token-store.ts. */
    oauthAccessToken?: string;
  }) {
    if (opts.oauthAccessToken) {
      // OAuth path: pass an empty apiKey so the SDK doesn't send x-api-key,
      // and override defaultHeaders with the bearer + OAuth beta header
      // that Claude's API requires for Max-subscription dispatch.
      this.client = new Anthropic({
        apiKey: '',
        baseURL: opts.baseURL,
        authToken: opts.oauthAccessToken,
        defaultHeaders: {
          'anthropic-beta': 'oauth-2025-04-20',
        },
      });
    } else {
      this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    }
    this.providerType = opts.providerType ?? 'claude';
    this.model = opts.model;
    this.maxOutputTokens = opts.maxOutputTokens;
  }

  async turn(input: AdapterTurnInput): Promise<AdapterTurnResult> {
    const messages = this.buildMessages(input);
    // Use the streaming endpoint and reduce to a final Message. The
    // Anthropic SDK rejects non-streaming requests when max_tokens is
    // high enough that the call could exceed 10 minutes
    // ("Streaming is required for operations that may take longer than
    // 10 minutes"). Streaming sidesteps that preflight rejection and
    // also keeps the connection alive for the actual long calls
    // reasoning-heavy models like deepseek-v4-pro do. `finalMessage()`
    // resolves to the same `Message` shape `messages.create()` returned,
    // so the rest of the adapter is unchanged.
    // When the caller marked the prefix as cacheable, send `system` as a
    // single text block with cache_control: { type: 'ephemeral' } attached.
    // Anthropic's Messages API caches the prefix up through that marker so
    // sibling sub-worker calls (criteria-fanout) can serve from cache.
    const systemPayload = input.cacheControl
      ? [{ type: 'text' as const, text: input.systemPrompt, cache_control: input.cacheControl }]
      : input.systemPrompt;
    const stream = this.client.messages.stream({
      model: this.model,
      system: systemPayload as any,
      messages,
      tools: this.mapTools(input.toolDefinitions),
      max_tokens: this.maxOutputTokens,
    });
    const response = await stream.finalMessage();

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

    // Tally every content-block type the provider returned so the runner
    // can emit a `runner_response_received` event that surfaces e.g.
    // `{ text: 0, thinking: 1 }` when deepseek emitted reasoning-only.
    // That diagnostic was missing in 4.0.x — the adapter silently dropped
    // non-text blocks and the runner-shell terminated with empty output.
    const contentBlocks: Record<string, number> = {};
    for (const b of response.content) {
      const t = (b as { type?: string }).type ?? 'unknown';
      contentBlocks[t] = (contentBlocks[t] ?? 0) + 1;
    }

    return {
      assistantText: text,
      toolCalls,
      usage,
      finishReason: toolCalls.length > 0 ? 'tool_use' : (response.stop_reason === 'end_turn' ? 'stop' : 'max_tokens'),
      responseShape: {
        ...(response.stop_reason && { stopReason: response.stop_reason }),
        contentBlocks,
      },
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
