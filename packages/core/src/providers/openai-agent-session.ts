// OpenAIAgentSession — shared session wrapper for the OpenAI + Codex
// providers. Both flow through `@openai/agents`; the only difference is
// the underlying `OpenAI` client (api.openai.com vs codex backend with
// OAuth). Per-session client isolation: each session constructs its own
// `OpenAIProvider({ openAIClient })` and passes it as the `Runner`'s
// `modelProvider`. No global state.

import { Agent, Runner, applyPatchTool, shellTool, OpenAIProvider } from '@openai/agents';
import type OpenAI from 'openai';
import type { Session, SessionOpts, TurnOpts, TurnResult } from '../types/run-result.js';
import { normalizeOpenAIAgentsRun } from './normalize-openai-agents.js';
import { resolveRateCard, priceTokens } from '../bounded-execution/cost-compute.js';

export class OpenAIAgentSession implements Session {
  private readonly modelProvider: OpenAIProvider;
  private readonly agent: Agent;
  private readonly runner: Runner;
  private lastResponseId: string | undefined;
  private closed = false;

  constructor(private readonly args: { client: OpenAI; model: string; opts: SessionOpts }) {
    this.modelProvider = new OpenAIProvider({ openAIClient: args.client, useResponses: true });
    this.agent = new Agent({ model: args.model, tools: [applyPatchTool, shellTool] });
    this.runner = new Runner({ modelProvider: this.modelProvider });
  }

  async send(instruction: string, _opts?: TurnOpts): Promise<TurnResult> {
    if (this.closed) throw new Error('openai-agent-session: send() on closed session');
    const startMs = Date.now();
    const run = await this.runner.run(this.agent, instruction, {
      signal: this.args.opts.abortSignal,
      ...(this.lastResponseId && { previousResponseId: this.lastResponseId }),
    });
    const r = run as unknown as { lastResponseId?: string };
    if (typeof r.lastResponseId === 'string') this.lastResponseId = r.lastResponseId;

    const rateCard = resolveRateCard(this.args.model);
    const norm = normalizeOpenAIAgentsRun(run, {
      durationMs: Date.now() - startMs,
      costUSD: 0,
    });
    norm.costUSD = rateCard ? priceTokens(norm.usage, rateCard) : 0;
    return norm;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.modelProvider.close(); } catch { /* ignore */ }
  }
}
