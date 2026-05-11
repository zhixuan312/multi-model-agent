// ClaudeSession — wraps `@anthropic-ai/claude-agent-sdk`'s `query()` for
// multi-turn use. The session is constructed once per (task × tier) and
// reused across stages; each `send()` writes one user message onto the
// streamed prompt iterable and consumes events until the SDK signals the
// turn block is done (a `result` message).

import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Session, SessionOpts, TurnOpts, TurnResult } from '../types/run-result.js';
import { normalizeClaudeTurn } from './normalize-claude.js';
import { resolveRateCard, priceTokens } from '../bounded-execution/cost-compute.js';

export class ClaudeSession implements Session {
  private readonly q: Query;
  private inputResolvers: Array<(m: SDKUserMessage) => void> = [];
  private closed = false;

  constructor(private readonly args: { model: string; opts: SessionOpts; oauthAccessToken?: string }) {
    if (args.oauthAccessToken) process.env.ANTHROPIC_AUTH_TOKEN = args.oauthAccessToken;
    const promptIterable = this.makePromptIterable();
    this.q = query({
      prompt: promptIterable,
      options: {
        model: args.model,
        permissionMode: 'acceptEdits',
        cwd: args.opts.cwd,
        abortSignal: args.opts.abortSignal,
      } as Parameters<typeof query>[0]['options'],
    });
  }

  private async *makePromptIterable(): AsyncIterable<SDKUserMessage> {
    while (!this.closed) {
      const next = await new Promise<SDKUserMessage>((resolve) => {
        this.inputResolvers.push(resolve);
      });
      yield next;
    }
  }

  async send(instruction: string, _opts?: TurnOpts): Promise<TurnResult> {
    if (this.closed) throw new Error('claude-session: send() on closed session');
    const startMs = Date.now();
    // Wait for the iterable to register a resolver, then resolve it.
    // The iterable always pre-registers a resolver before yielding, so
    // by the time send() is called there is one in queue.
    while (this.inputResolvers.length === 0) {
      await new Promise((r) => setImmediate(r));
    }
    const resolver = this.inputResolvers.shift()!;
    resolver({
      type: 'user',
      message: { role: 'user', content: instruction },
      parent_tool_use_id: null,
    } as SDKUserMessage);

    const events: SDKMessage[] = [];
    for await (const ev of this.q) {
      events.push(ev);
      if ((ev as { type?: string }).type === 'result') break;
    }

    const rateCard = resolveRateCard(this.args.model);
    // First normalize with cost=0; we re-price below once usage is known.
    const norm = normalizeClaudeTurn(events, {
      durationMs: Date.now() - startMs,
      costUSD: 0,
    });
    norm.costUSD = rateCard ? priceTokens(norm.usage, rateCard) : 0;
    return norm;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.q.close(); } catch { /* ignore */ }
  }
}
