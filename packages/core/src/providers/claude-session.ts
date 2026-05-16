// ClaudeSession — wraps `@anthropic-ai/claude-agent-sdk`'s `query()`.
//
// Multi-turn pattern: claude-agent-sdk's `result` SDKMessage is terminal
// for a single `query()` invocation — the output iterable closes after
// it. To continue an existing conversation across stages we re-invoke
// `query({ resume: <sessionId> })`. The SDK persists session state at
// `~/.claude/projects/<dir>/<sessionId>/` so the next query reloads
// the full conversation history, giving the lifecycle the same
// cached-prefix continuity codex CLI gets from `codex exec resume`.
//
// Per send():
//   - First call: query() with no resume option; capture `session_id`
//     from any SDKMessage (it's stamped on every event including the
//     initial system message).
//   - Subsequent calls: query() with `resume: this.sessionId` so the
//     prior conversation is reloaded transparently.

import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Session, SessionOpts, TurnOpts, TurnResult } from '../types/run-result.js';
import { normalizeClaudeTurn } from './normalize-claude.js';
import { resolveRateCard, priceTokens } from '../bounded-execution/cost-compute.js';

interface BusLike { emit(event: Record<string, unknown>): void }

function busOf(opts: SessionOpts): BusLike | undefined {
  const b = opts.bus as { emit?: unknown } | undefined;
  return b && typeof b.emit === 'function' ? (b as BusLike) : undefined;
}

export class ClaudeSession implements Session {
  private closed = false;
  private turns = 0;
  private sessionId?: string;
  private readonly bus: BusLike | undefined;
  /** Active SDK query handle for the in-flight turn. Captured so close() can
   *  force-shut the query (releases the underlying SDK worker / network
   *  resources). Undefined between turns. */
  private activeQuery?: { close?: () => unknown };

  constructor(private readonly args: { model: string; opts: SessionOpts; oauthAccessToken?: string }) {
    if (args.oauthAccessToken) process.env.ANTHROPIC_AUTH_TOKEN = args.oauthAccessToken;
    this.bus = busOf(args.opts);
    this.bus?.emit({
      event: 'claude_session_starting',
      ts: new Date().toISOString(),
      model: args.model,
      cwd: args.opts.cwd,
      ...this.taskTag(),
    });
  }

  /** Returns task identity (batchId/taskIndex) from SessionOpts for event tagging.
   *  Required so the stall watchdog can filter the shared bus by task. */
  private taskTag(): { batchId?: string; taskIndex?: number } {
    return {
      ...(this.args.opts.batchId !== undefined && { batchId: this.args.opts.batchId }),
      ...(this.args.opts.taskIndex !== undefined && { taskIndex: this.args.opts.taskIndex }),
    };
  }

  async send(instruction: string, _opts?: TurnOpts): Promise<TurnResult> {
    if (this.closed) throw new Error('claude-session: send() on closed session');
    const startMs = Date.now();
    this.turns += 1;
    const turnIndex = this.turns;
    this.bus?.emit({
      event: 'claude_turn_started',
      ts: new Date().toISOString(),
      turn: turnIndex,
      resume: Boolean(this.sessionId),
      ...(this.sessionId && { sessionId: this.sessionId }),
      ...this.taskTag(),
    });

    // Single-shot prompt iterable. The SDK iterates this once to pull the
    // user message, then runs to `result`. Closing the iterable after the
    // first yield makes the SDK shut down cleanly instead of waiting for
    // a "next" message that will never come.
    async function* promptIterable(): AsyncIterable<SDKUserMessage> {
      yield {
        type: 'user',
        message: { role: 'user', content: instruction },
        parent_tool_use_id: null,
      } as SDKUserMessage;
    }

    const q = query({
      prompt: promptIterable(),
      options: {
        // (lifecycle: capture this handle so close() can force-shut)
        model: this.args.model,
        // v4.4: mma operates headlessly — never prompt the user for
        // tool permission. bypassPermissions tells the SDK to run every
        // tool without confirmation, the Claude analogue of codex's
        // --dangerously-bypass-approvals-and-sandbox.
        permissionMode: 'bypassPermissions',
        cwd: this.args.opts.cwd,
        abortSignal: this.args.opts.abortSignal,
        // Cross-stage continuity: reload prior conversation from the
        // SDK's session store (~/.claude/projects/<dir>/<sessionId>).
        ...(this.sessionId && { resume: this.sessionId }),
      } as Parameters<typeof query>[0]['options'],
    });
    this.activeQuery = q as unknown as { close?: () => unknown };

    const events: SDKMessage[] = [];
    try {
      for await (const ev of q) {
        events.push(ev);
        // Capture session_id from the first event that carries one so
        // the next send() can resume this conversation. Every SDKMessage
        // in the SDK ships a `session_id` field (stamped server-side).
        if (!this.sessionId) {
          const sid = (ev as { session_id?: unknown }).session_id;
          if (typeof sid === 'string' && sid.length > 0) this.sessionId = sid;
        }
        this.emitEventTelemetry(ev);
        if ((ev as { type?: string }).type === 'result') break;
      }
    } catch (err) {
      const e = err as { name?: string; message?: string };
      this.bus?.emit({
        event: 'claude_error',
        ts: new Date().toISOString(),
        name: e.name ?? 'unknown',
        message: e.message ?? String(err),
        ...this.taskTag(),
      });
      try { q.close(); } catch { /* ignore */ }
      this.activeQuery = undefined;
      throw err;
    }
    try { q.close(); } catch { /* ignore */ }
    this.activeQuery = undefined;

    const rateCard = resolveRateCard(this.args.model);
    const norm = normalizeClaudeTurn(events, {
      durationMs: Date.now() - startMs,
      costUSD: 0,
      model: this.args.model,
    });
    norm.costUSD = rateCard ? priceTokens(norm.usage, rateCard) : 0;

    this.bus?.emit({
      event: 'claude_turn_completed',
      ts: new Date().toISOString(),
      turn: turnIndex,
      inputTokens: norm.usage.inputTokens,
      outputTokens: norm.usage.outputTokens,
      cachedReadTokens: norm.usage.cachedReadTokens ?? 0,
      cachedNonReadTokens: norm.usage.cachedNonReadTokens ?? 0,
      terminationReason: norm.terminationReason,
      filesRead: norm.filesRead.length,
      filesWritten: norm.filesWritten.length,
      ...(norm.errorCode && { errorCode: norm.errorCode }),
      ...this.taskTag(),
    });

    return norm;
  }

  /**
   * Translate a single SDKMessage from claude-agent-sdk into mma
   * verbose-log events. Defensive against shape drift in the SDK —
   * unknown variants are ignored. Only emits when there's something a
   * human operator would want to see in real time.
   */
  private emitEventTelemetry(ev: SDKMessage): void {
    if (!this.bus) return;
    const ts = new Date().toISOString();
    const type = (ev as { type?: string }).type;
    if (type !== 'assistant') return;
    const message = (ev as { message?: { content?: unknown } }).message;
    const content = Array.isArray(message?.content) ? message!.content : [];
    for (const block of content) {
      const b = block as { type?: string; text?: string; name?: string; input?: unknown };
      if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
        this.bus.emit({
          event: 'claude_text_emission',
          ts,
          turn: this.turns,
          chars: b.text.length,
          preview: b.text.slice(0, 200),
          ...this.taskTag(),
        });
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        const inputPreview = typeof b.input === 'object' && b.input !== null
          ? JSON.stringify(b.input).slice(0, 300)
          : '';
        this.bus.emit({
          event: 'claude_tool_call',
          ts,
          turn: this.turns,
          tool: b.name,
          input: inputPreview,
          ...this.taskTag(),
        });
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const q = this.activeQuery;
    this.activeQuery = undefined;
    if (q && typeof q.close === 'function') {
      try { q.close(); } catch { /* ignore */ }
    }
    this.bus?.emit({ event: 'claude_session_closed', ts: new Date().toISOString(), ...this.taskTag() });
  }

  /** ClaudeSession runs entirely in-process via the SDK; there's no separate
   *  CLI subprocess to expose a pid for. Returning undefined tells the
   *  shutdown drain there is nothing to SIGKILL externally — close() handles
   *  it via the SDK query handle. */
  getPid(): number | undefined {
    return undefined;
  }
}
