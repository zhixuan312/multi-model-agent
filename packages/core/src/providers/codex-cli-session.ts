// CodexCliSession — v4.4 Session implementation that wraps the official
// `codex` CLI (codex-cli) as a subprocess. Every OpenAI-family backend
// flows through here: ChatGPT subscription (default), OpenAI proper (via
// model_providers.openai-api override), and any OpenAI-compatible endpoint
// (via model_providers.<custom> override).
//
// Why subprocess instead of an in-process SDK:
//   1. The codex backend (chatgpt.com/backend-api/codex) rejects every
//      hosted tool the @openai/agents SDK ships with — verified via live
//      probes 2026-05-11.
//   2. The codex CLI is OpenAI's own reference runtime — it speaks the
//      backend correctly, ships built-in tool impls (Seatbelt/Landlock
//      sandbox, file edit, shell), and exposes a stable `codex exec --json`
//      non-interactive mode with JSONL event output.
//   3. Multi-turn continuity via `codex exec resume <session_id>` is
//      verified end-to-end (gpt-5.5 recalled prior-turn context across a
//      fresh process spawn).

import type { ChildProcess } from 'node:child_process';
// cross-spawn: POSIX-passthrough on Linux/macOS (delegates to node:child_process spawn
// without behavior change), and on Windows resolves `.cmd`/`.bat`/`.ps1` shims (e.g.
// `codex.cmd`) that node's native spawn cannot find without `shell: true` — which
// would be unsafe for our args (the `-c model_providers.X={…}` block contains shell
// metacharacters that cmd.exe would mangle). Single-purpose import.
import spawn from 'cross-spawn';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Session, SessionOpts, TurnOpts, TurnResult, TokenUsage } from '../types/run-result.js';
import { resolveRateCard, priceTokens } from '../bounded-execution/cost-compute.js';
import { buildCodexCliLaunch, type CodexCliConfig } from './codex-cli-launch.js';
import { parseCodexCliEvent, type CodexCliEvent, type CodexItem, type CodexUsage } from './codex-cli-event.js';

const SIGKILL_GRACE_MS = 3000;
/** Grace window during session.close() between SIGTERM and SIGKILL. Keeps
 *  task teardown bounded so the spec invariant "task done → children die"
 *  holds within 2s for normal teardown. */
const CLOSE_GRACE_MS = 2000;

interface BusLike { emit(event: Record<string, unknown>): void }

function busOf(opts: SessionOpts): BusLike | undefined {
  const b = opts.bus as { emit?: unknown } | undefined;
  return b && typeof b.emit === 'function' ? (b as BusLike) : undefined;
}

export class CodexCliSession implements Session {
  private threadId?: string;
  private closed = false;
  private tempDir?: string;
  /** Active codex CLI subprocess for the currently-running turn. Captured so
   *  close() can synchronously kill the child (SIGTERM then SIGKILL after
   *  CLOSE_GRACE_MS). Undefined between turns. */
  private activeProc?: ChildProcess;
  private readonly cumulativeUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedNonReadTokens: 0,
  };

  constructor(private readonly args: { cfg: CodexCliConfig; opts: SessionOpts }) {}

  /** Returns task identity (batchId/taskIndex) from SessionOpts for event tagging.
   *  The stall watchdog filters bus events by these fields — every emit must carry them
   *  or stuck detection re-breaks under concurrent load. */
  private taskTag(): { batchId?: string; taskIndex?: number } {
    return {
      ...(this.args.opts.batchId !== undefined && { batchId: this.args.opts.batchId }),
      ...(this.args.opts.taskIndex !== undefined && { taskIndex: this.args.opts.taskIndex }),
    };
  }

  async send(instruction: string, _turnOpts?: TurnOpts): Promise<TurnResult> {
    if (this.closed) throw new Error('codex-cli-session: send() on closed session');
    const startMs = Date.now();

    if (!this.tempDir) this.tempDir = await mkdtemp(join(tmpdir(), 'mma-codex-'));
    const outputFile = join(this.tempDir, `out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);

    const launch = buildCodexCliLaunch({
      cfg: this.args.cfg,
      opts: { cwd: this.args.opts.cwd },
      outputFile,
      ...(this.threadId && { resumeSessionId: this.threadId }),
    });

    const bus = busOf(this.args.opts);
    const tag = this.taskTag();
    const tracker = new TurnTracker(this.cumulativeUsage, bus, tag);

    bus?.emit({
      event: 'codex_subprocess_starting',
      ts: new Date().toISOString(),
      model: this.args.cfg.model,
      cwd: this.args.opts.cwd,
      resume: Boolean(this.threadId),
      ...(this.threadId && { threadId: this.threadId }),
      ...tag,
    });

    let proc: ChildProcess;
    try {
      // Always set the subprocess cwd. `codex exec` honors `-C` on the
      // initial call but `codex exec resume` does NOT accept `-C`, so on
      // resume codex CLI inherits whatever cwd we spawn it in. Without
      // this, the rework/annotate stages run in the mma server's process
      // cwd and the worker has to re-discover the workspace via `../path`
      // hacks — wastes turns + cost. Setting spawn cwd makes both paths
      // behave identically.
      proc = spawn(launch.command, launch.args, {
        cwd: this.args.opts.cwd,
        env: launch.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // detached: true puts codex (and any helpers it spawns) into its
        // own process group, so killGracefully can signal the whole tree
        // via process.kill(-pid, ...). Without this, codex grandchildren
        // survived SIGTERM to the leader — see 2026-05-16 leak (155 net
        // orphans across the day, peak ~91 simultaneous at 02:00 UTC).
        detached: true,
      });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      bus?.emit({
        event: 'codex_spawn_failed',
        ts: new Date().toISOString(),
        code: e.code ?? 'unknown',
        message: e.message ?? String(err),
        ...tag,
      });
      return this.finalizeError(tracker, startMs, e.code === 'ENOENT' ? 'codex_not_installed' : 'spawn_failed', e.message ?? String(err));
    }

    bus?.emit({
      event: 'codex_subprocess_started',
      ts: new Date().toISOString(),
      pid: proc.pid ?? -1,
      ...tag,
    });

    this.activeProc = proc;
    proc.stdin?.write(instruction);
    proc.stdin?.end();

    const cleanupGuards = this.armGuards(proc, tracker);
    const stderrBufRef = { value: '' };
    try {
      await consumeStream(proc, tracker, stderrBufRef);
    } finally {
      cleanupGuards();
      this.activeProc = undefined;
    }

    if (tracker.threadId) this.threadId = tracker.threadId;

    bus?.emit({
      event: 'codex_subprocess_exited',
      ts: new Date().toISOString(),
      exitCode: proc.exitCode,
      turns: tracker.turns,
      terminationReason: tracker.terminationReason,
      ...(tracker.errorCode && { errorCode: tracker.errorCode }),
      ...(stderrBufRef.value && { stderrTail: stderrBufRef.value.slice(-500) }),
      ...(proc.pid !== undefined && { pid: proc.pid }),
      ...tag,
    });

    const finalMessage = tracker.lastAgentMessage || await readOutputFile(outputFile);
    const turnUsage = tracker.flushUsageDelta();
    const rateCard = resolveRateCard(this.args.cfg.model);
    const costUSD = rateCard ? priceTokens(turnUsage, rateCard) : 0;

    if (tracker.terminationReason === 'ok' && proc.exitCode !== 0 && proc.exitCode !== null) {
      tracker.terminationReason = 'error';
      tracker.errorCode = `exit_${proc.exitCode}`;
      tracker.errorMessage = (stderrBufRef.value || `codex exited ${proc.exitCode}`).slice(0, 2000);
    }

    return {
      output: finalMessage,
      usage: turnUsage,
      filesRead: [...tracker.filesRead],
      filesWritten: [...tracker.filesWritten],
      toolCallsByName: tracker.toolCallsByName,
      turns: tracker.turns,
      durationMs: Date.now() - startMs,
      costUSD,
      terminationReason: tracker.terminationReason,
      ...(tracker.errorCode && { errorCode: tracker.errorCode }),
      ...(tracker.errorMessage && { errorMessage: tracker.errorMessage }),
      model: this.args.cfg.model,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const proc = this.activeProc;
    this.activeProc = undefined;
    // Synchronous child termination guarantee: SIGTERM, then SIGKILL after
    // CLOSE_GRACE_MS if still alive. Without this, close() leaked codex
    // children — see 2026-05-16 leak post-mortem.
    if (proc && proc.exitCode === null && !proc.killed) {
      try { killGracefully(proc); } catch { /* ignore */ }
      await new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => { if (!settled) { settled = true; clearTimeout(t); resolve(); } };
        proc.once('exit', settle);
        const t = setTimeout(() => {
          if (settled) return;
          try {
            // SIGKILL the whole process group (proc was spawned detached).
            if (typeof proc.pid === 'number') process.kill(-proc.pid, 'SIGKILL');
          } catch { /* ignore */ }
          settle();
        }, CLOSE_GRACE_MS);
        t.unref();
      });
    }
    if (this.tempDir) {
      const dir = this.tempDir;
      this.tempDir = undefined;
      await rm(dir, { recursive: true, force: true }).catch(() => { /* swallow */ });
    }
  }

  /** OS pid of the currently-active codex CLI subprocess, if any. Undefined
   *  between turns. Used by shutdown drain to SIGKILL stragglers. */
  getPid(): number | undefined {
    return this.activeProc?.pid;
  }

  private armGuards(proc: ChildProcess, tracker: TurnTracker): () => void {
    const onAbort = () => {
      if (tracker.terminationReason === 'ok') {
        tracker.terminationReason = 'aborted';
        tracker.errorCode = 'aborted';
      }
      killGracefully(proc);
    };
    const deadlineMs = Math.max(0, this.args.opts.wallClockDeadline - Date.now());
    let deadlineTimer: NodeJS.Timeout | undefined;
    if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
      deadlineTimer = setTimeout(() => {
        if (tracker.terminationReason === 'ok') {
          tracker.terminationReason = 'time_exceeded';
          tracker.errorCode = 'wall_clock_exceeded';
        }
        killGracefully(proc);
      }, deadlineMs);
      deadlineTimer.unref();
    }
    if (this.args.opts.abortSignal.aborted) {
      onAbort();
    } else {
      this.args.opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    return () => {
      this.args.opts.abortSignal.removeEventListener('abort', onAbort);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    };
  }


  private finalizeError(tracker: TurnTracker, startMs: number, code: string, message: string): TurnResult {
    tracker.terminationReason = 'error';
    tracker.errorCode = code;
    tracker.errorMessage = message;
    return {
      output: '',
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      filesRead: [],
      filesWritten: [],
      toolCallsByName: {},
      turns: 0,
      durationMs: Date.now() - startMs,
      costUSD: 0,
      terminationReason: 'error',
      errorCode: code,
      errorMessage: message,
    };
  }
}

async function readOutputFile(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return '';
  }
}

function consumeStream(proc: ChildProcess, tracker: TurnTracker, stderrRef: { value: string }): Promise<void> {
  let stdoutBuf = '';
  proc.stdout?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    let nl: number;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      const ev = parseCodexCliEvent(line);
      if (ev) tracker.consume(ev);
    }
  });
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    stderrRef.value += chunk;
    if (stderrRef.value.length > 8000) stderrRef.value = stderrRef.value.slice(-4000);
  });
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (stdoutBuf) {
        const ev = parseCodexCliEvent(stdoutBuf);
        if (ev) tracker.consume(ev);
      }
      resolve();
    };
    // 'exit' fires when the child process itself terminates, independent
    // of whether stdio pipes have drained. Grandchildren that inherit
    // the pipes can keep 'close' pending indefinitely — see 2026-05-16
    // log leak (341 codex_subprocess_starting vs 186 codex_subprocess_exited).
    proc.on('exit', settle);
    proc.on('close', settle);
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (tracker.terminationReason === 'ok') {
        tracker.terminationReason = 'error';
        tracker.errorCode = err.code === 'ENOENT' ? 'codex_not_installed' : 'spawn_failed';
        tracker.errorMessage = err.message;
      }
      settle();
    });
  });
}

function killGracefully(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.killed) return;
  const pid = proc.pid;
  // Signal the whole process group (negative pid). Codex spawns helpers
  // that share the leader's stdio; killing the leader alone leaks them.
  // Fall back to leader-only kill when pid is unavailable (e.g. spawn
  // failed before a pid was assigned).
  try {
    if (typeof pid === 'number') process.kill(-pid, 'SIGTERM');
    else proc.kill('SIGTERM');
  } catch { /* group may already be gone */ }
  const t = setTimeout(() => {
    if (proc.exitCode === null) {
      try {
        if (typeof pid === 'number') process.kill(-pid, 'SIGKILL');
        else proc.kill('SIGKILL');
      } catch { /* group may already be gone */ }
    }
  }, SIGKILL_GRACE_MS);
  t.unref();
}

/** Internal — visible only to the test harness via re-export. */
class TurnTracker {
  threadId?: string;
  turns = 0;
  lastAgentMessage = '';
  filesRead = new Set<string>();
  filesWritten = new Set<string>();
  toolCallsByName: Record<string, number> = {};
  terminationReason: TurnResult['terminationReason'] = 'ok';
  errorCode?: string;
  errorMessage?: string;
  private readonly snapshot: TokenUsage;

  constructor(
    private readonly cumulative: TokenUsage,
    private readonly bus?: BusLike,
    private readonly tag: { batchId?: string; taskIndex?: number } = {},
  ) {
    this.snapshot = { ...cumulative };
  }

  consume(ev: CodexCliEvent): void {
    const ts = new Date().toISOString();
    switch (ev.kind) {
      case 'thread_started':
        if (ev.threadId) this.threadId = ev.threadId;
        this.bus?.emit({ event: 'codex_thread_started', ts, threadId: ev.threadId, ...this.tag });
        break;
      case 'turn_started':
        this.turns += 1;
        this.bus?.emit({ event: 'codex_turn_started', ts, turn: this.turns, ...this.tag });
        break;
      case 'item_started':
        if (ev.item.type === 'command_execution') {
          this.bus?.emit({
            event: 'codex_command_started',
            ts,
            command: String(ev.item.command ?? '').slice(0, 500),
            ...this.tag,
          });
        }
        break;
      case 'item_completed':
        this.absorbItem(ev.item);
        break;
      case 'turn_completed':
        this.absorbUsage(ev.usage);
        this.bus?.emit({
          event: 'codex_turn_completed',
          ts,
          turn: this.turns,
          inputTokens: ev.usage.input_tokens ?? 0,
          outputTokens: (ev.usage.output_tokens ?? 0) + (ev.usage.reasoning_output_tokens ?? 0),
          cachedInputTokens: ev.usage.cached_input_tokens ?? 0,
          ...this.tag,
        });
        break;
      case 'turn_failed':
        if (this.terminationReason === 'ok') {
          this.terminationReason = 'error';
          this.errorCode = 'turn_failed';
          this.errorMessage = ev.error.message;
        }
        this.bus?.emit({ event: 'codex_turn_failed', ts, message: ev.error.message, ...this.tag });
        break;
      case 'error':
        if (this.terminationReason === 'ok') {
          this.terminationReason = 'error';
          this.errorCode = 'codex_error';
          this.errorMessage = ev.message;
        }
        this.bus?.emit({ event: 'codex_error', ts, message: ev.message, ...this.tag });
        break;
      default:
        break;
    }
  }

  private absorbItem(item: CodexItem): void {
    const ts = new Date().toISOString();
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      this.lastAgentMessage = item.text;
      this.bus?.emit({
        event: 'codex_agent_message',
        ts,
        chars: item.text.length,
        preview: item.text.slice(0, 200),
        ...this.tag,
      });
    } else if (item.type === 'command_execution') {
      this.toolCallsByName['run_shell'] = (this.toolCallsByName['run_shell'] ?? 0) + 1;
      this.bus?.emit({
        event: 'codex_command_completed',
        ts,
        command: String(item.command ?? '').slice(0, 500),
        exitCode: item.exit_code ?? null,
        ...this.tag,
      });
    } else if (item.type === 'file_change') {
      this.toolCallsByName['edit_file'] = (this.toolCallsByName['edit_file'] ?? 0) + 1;
      if (typeof item.path === 'string') this.filesWritten.add(item.path);
      this.bus?.emit({
        event: 'codex_file_change',
        ts,
        ...(typeof item.path === 'string' && { path: item.path }),
        ...this.tag,
      });
    }
  }

  private absorbUsage(u: CodexUsage): void {
    // OpenAI / codex CLI emits `input_tokens` as GROSS (it INCLUDES
    // `cached_input_tokens` as a subset — confirmed by codex's own Rust
    // protocol: `non_cached_input = input_tokens - cached_input()`).
    // Anthropic's API emits `input_tokens` as NET (post-breakpoint only,
    // disjoint from cache fields). Our cross-provider TokenUsage contract
    // expects Anthropic's disjoint shape so that `priceTokens` can apply
    // separate rates to each bucket without double-billing.
    //
    // Normalize here: subtract cached out of gross BEFORE storing, so
    // `inputTokens` on the wire is the non-cached prompt-token count and
    // `cachedReadTokens` is the disjoint cached subset. priceTokens then
    // computes (input × inputRate) + (cached × cachedRate) correctly.
    //
    // reasoning_output_tokens IS disjoint from output_tokens in codex's
    // protocol (per Rust source) — adding them together gives the correct
    // total billable-output count. gpt-5.x charges reasoning at the same
    // per-token rate as output, so a single rate applies to the sum.
    const cached = u.cached_input_tokens ?? 0;
    const gross = u.input_tokens ?? 0;
    this.cumulative.inputTokens += Math.max(0, gross - cached);
    this.cumulative.outputTokens += (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
    this.cumulative.cachedReadTokens += cached;
  }

  flushUsageDelta(): TokenUsage {
    return {
      inputTokens: this.cumulative.inputTokens - this.snapshot.inputTokens,
      outputTokens: this.cumulative.outputTokens - this.snapshot.outputTokens,
      cachedReadTokens: this.cumulative.cachedReadTokens - this.snapshot.cachedReadTokens,
      cachedNonReadTokens: 0,
    };
  }
}

// Re-export the tracker for tests that want to unit-test consume() in
// isolation. Not part of the public API.
export const __test = { TurnTracker, killGracefully, consumeStream };

/** Helper for tests/probes: write a JSON-schema object to a temp file
 *  and return its path. Used when callers want `--output-schema`. The
 *  caller is responsible for cleanup; in practice CodexCliSession.close()
 *  removes its tempDir which includes any schema files written there. */
export async function writeSchemaFile(dir: string, schema: object): Promise<string> {
  const p = join(dir, `schema-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(p, JSON.stringify(schema), 'utf8');
  return p;
}
