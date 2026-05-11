// OpenAIAgentSession — shared session wrapper for the OpenAI + Codex
// providers. Both flow through `@openai/agents`; the only difference is
// the underlying `OpenAI` client (api.openai.com vs codex backend with
// OAuth). Per-session client isolation: each session constructs its own
// `OpenAIProvider({ openAIClient })` and passes it as the `Runner`'s
// `modelProvider`. No global state.

import { Agent, Runner, OpenAIProvider } from '@openai/agents';
import OpenAI from 'openai';
import type { Session, SessionOpts, TurnOpts, TurnResult } from '../types/run-result.js';
import { normalizeOpenAIAgentsRun } from './normalize-openai-agents.js';
import { resolveRateCard, priceTokens } from '../bounded-execution/cost-compute.js';
import { createToolImplementations } from './tool-impls.js';
import { createOpenAITools } from './openai-tools.js';
import { COMMIT_BLOCK_GUIDANCE } from './brief-preamble.js';

const SUB_AGENT_INSTRUCTIONS = [
  'You are a sub-agent completing a single task end-to-end. Your final assistant message is what gets returned to the caller.',
  'Plan before you act. State a brief plan in your first message. Read files before editing. Trust edit_file/write_file — do not re-read after a successful edit.',
  'When you have completed the task, produce a final answer summarizing what you did.',
  '',
  COMMIT_BLOCK_GUIDANCE,
].join('\n');

export class OpenAIAgentSession implements Session {
  private readonly modelProvider: OpenAIProvider;
  private readonly agent: Agent;
  private readonly runner: Runner;
  private lastResponseId: string | undefined;
  private closed = false;

  constructor(private readonly args: { client: OpenAI; model: string; opts: SessionOpts }) {
    // OpenAI client identity passes between the openai package's import-mode
    // resolution variants — the OpenAIProvider option is structurally
    // compatible. Cast through `unknown` to bypass the nominal-type drift.
    this.modelProvider = new OpenAIProvider({
      openAIClient: args.client as unknown as never,
      useResponses: true,
    });
    const impl = createToolImplementations({
      cwd: args.opts.cwd,
      signal: args.opts.abortSignal,
    });
    const tools = createOpenAITools(impl);
    this.agent = new Agent({
      name: 'sub-agent',
      model: args.model,
      instructions: SUB_AGENT_INSTRUCTIONS,
      tools,
    });
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
