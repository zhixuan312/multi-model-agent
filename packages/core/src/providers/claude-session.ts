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
import type { Effort } from '../types/task-spec.js';
import { normalizeClaudeTurn } from './normalize-claude.js';
import { resolveRateCard, priceTokens } from '../bounded-execution/cost-compute.js';
import { mapProviderEventToPlainEntry } from '../events/plain-log-entry.js';
import { writeClaudePluginWrapper, buildClaudeSkillOptions } from './claude-skill-plugin.js';
import { buildConfinementHook } from './claude-cwd-confinement.js';
import { type BusLike, busOf, wallClockDelayMs } from './session-helpers.js';

export class ClaudeSession implements Session {
  private closed = false;
  private turns = 0;
  private sessionId?: string;
  private skillPluginReady = false;
  private readonly bus: BusLike | undefined;
  /** Active SDK query handle for the in-flight turn. Captured so close() can
   *  force-shut the query (releases the underlying SDK worker / network
   *  resources). Undefined between turns. */
  private activeQuery?: { close?: () => unknown };

  constructor(private readonly args: {
    model: string;
    opts: SessionOpts;
    apiKey?: string;
    baseUrl?: string;
    oauthAccessToken?: string;
    /** Resolved reasoning level (default applied, capability-gated by
     *  providers/effort.ts). Absent → send no effort option at all. */
    effort?: Effort;
  }) {
    this.bus = busOf(args.opts);
    if (args.opts.resume) this.sessionId = args.opts.resume;
    this.bus?.emitPlainEntry(mapProviderEventToPlainEntry('claude', 'claude_session_starting', {
      model: args.model,
      cwd: args.opts.cwd,
      ...this.taskTag(),
    }));
  }

  /** Returns task identity (taskId/taskIndex) from SessionOpts for event tagging.
   *  Required so the stall watchdog can filter the shared bus by task. */
  private taskTag(): { taskId?: string; taskIndex?: number } {
    return {
      ...(this.args.opts.taskId !== undefined && { taskId: this.args.opts.taskId }),
      ...(this.args.opts.taskIndex !== undefined && { taskIndex: this.args.opts.taskIndex }),
    };
  }

  async send(instruction: string, _opts?: TurnOpts): Promise<TurnResult> {
    if (this.closed) throw new Error('claude-session: send() on closed session');
    const startMs = Date.now();
    this.turns += 1;
    const turnIndex = this.turns;
    this.bus?.emitPlainEntry(mapProviderEventToPlainEntry('claude', 'claude_turn_started', {
      turn: turnIndex,
      resume: Boolean(this.sessionId),
      ...(this.sessionId && { sessionId: this.sessionId }),
      ...this.taskTag(),
    }));

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

    const skillBundle = this.args.opts.skills;
    if (skillBundle && !this.skillPluginReady) {
      await writeClaudePluginWrapper(skillBundle.stagedRoot, skillBundle.names);
      this.skillPluginReady = true;
    }
    const skillOptions = skillBundle ? buildClaudeSkillOptions(skillBundle.stagedRoot, skillBundle.names) : {};

    // Assemble SDK hooks. Two independent concerns, merged into one `hooks` map:
    //   1. Goal-mode Stop hook (replicates /goal): re-block stop until the
    //      goalCondition is met.
    //   2. cwd confinement (cwd-only tasks): a PreToolUse hook that denies writes
    //      escaping the workspace — the SDK equivalent of codex `-s workspace-write`,
    //      since `bypassPermissions` itself applies no filesystem boundary.
    const hookMap: Record<string, unknown> = {};
    if (_opts?.goalCondition) {
      const condition = _opts.goalCondition;
      hookMap.Stop = [{
        hooks: [async (input: { stop_hook_active?: boolean }) => {
          if (input.stop_hook_active) return {};
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'Stop',
              decision: 'block',
              reason: `Goal not yet met. Continue working toward: ${condition}`,
            },
          };
        }],
      }];
    }
    if (this.args.opts.sandboxPolicy) {
      // No `&& cwd` guard: a `read-only` policy needs no cwd, and requiring one meant a
      // read-only session without a cwd installed no hook at all. `buildConfinementHook`
      // falls back to the read-only evaluator when a `cwd-only` policy arrives with no cwd,
      // which is the restrictive answer rather than the absent one.
      Object.assign(hookMap, buildConfinementHook(this.args.opts.sandboxPolicy, this.args.opts.cwd));
    }
    const goalHooks: Record<string, unknown> = Object.keys(hookMap).length ? { hooks: hookMap } : {};

    // Reasoning level. The SDK has no 'none' level — that's `thinking:
    // disabled` — so 'none' routes there and every other level goes to the
    // `effort` option verbatim. Levels the selected model doesn't support are
    // downgraded by the SDK itself; mma doesn't model per-model ladders.
    const effortOptions: Record<string, unknown> = this.args.effort === 'none'
      ? { thinking: { type: 'disabled' } }
      : this.args.effort ? { effort: this.args.effort } : {};

    // Auth env. `type: 'claude'` spans both api.anthropic.com and any
    // Anthropic-compatible proxy, and they differ in auth header: the real API
    // takes x-api-key (ANTHROPIC_API_KEY) only, while proxies vary — Ollama
    // Cloud, z.ai, DeepSeek, Kimi and MiniMax all document Authorization:
    // Bearer (ANTHROPIC_AUTH_TOKEN), but gateways fronting api.anthropic.com
    // forward x-api-key. Sending only the wrong one surfaces as a hung turn
    // rather than an error, so against a custom baseUrl the key goes out as
    // both and each endpoint reads the header it knows (the SDK merges the two
    // auth headers rather than picking one). No baseUrl means api.anthropic.com,
    // where Bearer is reserved for OAuth — key stays on x-api-key alone.
    const proxied = Boolean(this.args.baseUrl);
    const env: Record<string, string | undefined> = { ...process.env };
    // The destination is config's to decide, never the ambient environment's, so
    // an unset baseUrl must DELETE the inherited value rather than merely decline
    // to override it. Inheriting it breaks two things at once: the configured key
    // goes to a host this session never chose, and `proxied` — derived from config
    // — stays false, so the Bearer header that host would need never goes out. The
    // result is a leaked key and a hung turn, which is precisely the failure the
    // paragraph above exists to prevent.
    if (this.args.baseUrl) env.ANTHROPIC_BASE_URL = this.args.baseUrl;
    else delete env.ANTHROPIC_BASE_URL;
    // Cleared unconditionally when proxied: an inherited Anthropic key must
    // never outrank the configured one, nor leak to a third-party endpoint.
    if (proxied || this.args.apiKey) {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    if (this.args.apiKey) {
      env.ANTHROPIC_API_KEY = this.args.apiKey;
      if (proxied) env.ANTHROPIC_AUTH_TOKEN = this.args.apiKey;
    }
    // Subscription OAuth: drop any inherited key too, or api.anthropic.com sees
    // an x-api-key beside the Bearer token and bills the key instead of the plan.
    if (this.args.oauthAccessToken) {
      delete env.ANTHROPIC_API_KEY;
      env.ANTHROPIC_AUTH_TOKEN = this.args.oauthAccessToken;
    }

    const q = query({
      prompt: promptIterable(),
      options: {
        model: this.args.model,
        permissionMode: 'bypassPermissions',
        cwd: this.args.opts.cwd,
        abortSignal: this.args.opts.abortSignal,
        env,
        ...skillOptions,
        ...effortOptions,
        ...(this.sessionId && { resume: this.sessionId }),
        ...goalHooks,
        ...(this.args.opts.disallowedTools?.length && { disallowedTools: this.args.opts.disallowedTools }),
      } as Parameters<typeof query>[0]['options'],
    });
    this.activeQuery = q as unknown as { close?: () => unknown };

    // Wall-clock bound (parity with the codex runner's armGuards): when the
    // deadline elapses, force-close the SDK query so the turn returns instead of
    // running unbounded. Previously claude only forwarded opts.abortSignal, which
    // nothing fires — so claude turns had no wall-clock limit at all.
    let timedOut = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadlineDelayMs = wallClockDelayMs(this.args.opts.wallClockDeadline);
    if (deadlineDelayMs !== null) {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        try { q.close(); } catch { /* ignore */ }
      }, deadlineDelayMs);
      deadlineTimer.unref();
    }

    // Cancellation bound. Forwarding opts.abortSignal into the SDK alone is not
    // enough: the SDK finishes the in-flight turn before honouring it, so a
    // cancelled task kept billing tokens for tens of seconds (measured ~48s on
    // a multi-turn file-reading turn). Force-close the query the same way the
    // deadline guard does — this is the claude-side equivalent of the codex
    // runner's process-group kill, giving both runners the same
    // cancel-means-stop-now behaviour.
    let aborted = false;
    const signal = this.args.opts.abortSignal;
    const onAbort = () => {
      aborted = true;
      try { q.close(); } catch { /* ignore */ }
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    const clearGuards = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      signal.removeEventListener('abort', onAbort);
    };

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
      // A guard-induced close() (deadline or cancellation) surfaces as an
      // iterator error — that is a bounded stop, not a provider failure.
      // Rethrow only real errors.
      if (!timedOut && !aborted) {
        clearGuards();
        const e = err as { name?: string; message?: string };
        this.bus?.emitPlainEntry(mapProviderEventToPlainEntry('claude', 'claude_error', {
          name: e.name ?? 'unknown',
          message: e.message ?? String(err),
          ...this.taskTag(),
        }));
        try { q.close(); } catch { /* ignore */ }
        this.activeQuery = undefined;
        throw err;
      }
    }
    clearGuards();
    try { q.close(); } catch { /* ignore */ }
    this.activeQuery = undefined;

    const rateCard = resolveRateCard(this.args.model);
    // Caller cancellation outranks the deadline: when both fired, `aborted` is
    // the actionable reason (the caller asked to stop; the deadline is
    // incidental). Either way the guard reason wins over the SDK's own
    // termination — a force-closed stream must never report `ok`.
    const guardReason = aborted ? 'aborted' as const : timedOut ? 'time_exceeded' as const : undefined;
    const norm = normalizeClaudeTurn(events, {
      durationMs: Date.now() - startMs,
      costUSD: 0,
      ...(guardReason ? { guardTerminationReason: guardReason } : {}),
    });
    if (!norm.errorCode) {
      if (aborted) norm.errorCode = 'aborted';
      else if (timedOut) norm.errorCode = 'wall_clock_exceeded';
    }
    norm.costUSD = rateCard ? priceTokens(norm.usage, rateCard) : 0;

    this.bus?.emitPlainEntry(mapProviderEventToPlainEntry('claude', 'claude_turn_completed', {
      turn: turnIndex,
      inputTokens: norm.usage.inputTokens,
      outputTokens: norm.usage.outputTokens,
      cachedReadTokens: norm.usage.cachedReadTokens ?? 0,
      cachedNonReadTokens: norm.usage.cachedNonReadTokens ?? 0,
      terminationReason: norm.terminationReason,
      filesWritten: norm.filesWritten.length,
      ...(norm.errorCode && { errorCode: norm.errorCode }),
      ...this.taskTag(),
    }));

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
    const type = (ev as { type?: string }).type;
    // Compaction observability (goal mode): the SDK emits a `compact_boundary`
    // system message when it auto-compacts the conversation. Surface it so long
    // goal-set runs are no longer blind to context compaction. Observe-only.
    if (type === 'system' && (ev as { subtype?: string }).subtype === 'compact_boundary') {
      const meta = (ev as { compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number } }).compact_metadata ?? {};
      this.bus.emitPlainEntry(mapProviderEventToPlainEntry('claude', 'claude_compaction', {
        turn: this.turns,
        trigger: meta.trigger ?? 'unknown',
        preTokens: meta.pre_tokens ?? 0,
        postTokens: meta.post_tokens ?? 0,
        ...this.taskTag(),
      }));
      return;
    }
    if (type !== 'assistant') return;
    const message = (ev as { message?: { content?: unknown } }).message;
    const content = Array.isArray(message?.content) ? message!.content : [];
    for (const block of content) {
      const b = block as { type?: string; text?: string; name?: string; input?: unknown };
      if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
        this.bus.emitPlainEntry(mapProviderEventToPlainEntry('claude', 'claude_text_emission', {
          turn: this.turns,
          chars: b.text.length,
          preview: b.text.slice(0, 200),
          ...this.taskTag(),
        }));
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        const inputPreview = typeof b.input === 'object' && b.input !== null
          ? JSON.stringify(b.input).slice(0, 300)
          : '';
        this.bus.emitPlainEntry(mapProviderEventToPlainEntry('claude', 'claude_tool_call', {
          turn: this.turns,
          tool: b.name,
          input: inputPreview,
          ...this.taskTag(),
        }));
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
    this.bus?.emitPlainEntry(mapProviderEventToPlainEntry('claude', 'claude_session_closed', {
      ...this.taskTag(),
    }));
  }

  getSessionId(): string | null {
    return this.sessionId ?? null;
  }

  /** ClaudeSession runs entirely in-process via the SDK; there's no separate
   *  CLI subprocess to expose a pid for. Returning undefined tells the
   *  shutdown drain there is nothing to SIGKILL externally — close() handles
   *  it via the SDK query handle. */
  getPid(): number | undefined {
    return undefined;
  }
}
