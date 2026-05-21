// packages/core/src/bounded-execution/progress-watchdog.ts
import { spawn } from 'node:child_process';
import { getRealFilesChanged } from '../lifecycle/real-diff.js';
import { normalizeScopeEntry, isInScope, type NormalizedScopeEntry } from '../lifecycle/scope-match.js';
import type { LifecycleState } from '../lifecycle/stage-plan-types.js';

export interface ProgressWatchdogConfig {
  enabled: boolean;
  thrashTurns: number;
  thrashWallClockMs: number;
  thrashSoftWallClockMs: number;   // soft warn at this elapsed time (default = thrashWallClockMs/2)
}

export interface ProgressWatchdogContext {
  state: LifecycleState;
  controller: AbortController;     // session's abort signal; .abort() fires Signal 1 mid-flight
  emit: (event: Record<string, unknown>) => void;
  config: ProgressWatchdogConfig;
  taskIndex: number;               // canonical task identifier (see lifecycle-context.ts:32)
  batchId?: string;
  /** State the watchdog mutates: `fired` so post-hoc code knows the abort came from us. */
  state2: { fired: boolean };
}

async function gitDiffNameOnly(cwd: string, preSha: string): Promise<string[]> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: string[]) => { if (!settled) { settled = true; resolve(v); } };
    const child = spawn('git', ['diff', '--name-only', `${preSha}..`], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.on('error', () => done([]));
    child.on('exit', (code) => {
      if (code !== 0) { done([]); return; }
      done(out.split('\n').filter(Boolean));
    });
  });
}

/**
 * Starts the progress watchdog. Returns a disposer that MUST be called in a
 * finally{} block. Mirrors startStallWatchdog(): same shape, single function
 * call, returns cleanup. The watchdog polls on a setInterval; when conditions
 * trip, it fires `controller.abort()` to interrupt the in-flight session.send().
 *
 * Post-hoc signals (turn-count thrash detection and scope-violation analysis)
 * are handled by recordPostHocSignals() below, called AFTER session.send()
 * returns. They mutate state for the annotator to consume.
 */
export function startProgressWatchdog(ctx: ProgressWatchdogContext): () => void {
  const ts = () => new Date().toISOString();
  const meta = {
    ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
    taskIndex: ctx.taskIndex,
  };

  // Three skip conditions evaluated once at arm:
  if (!ctx.config.enabled) {
    ctx.emit({ event: 'progress_watchdog_skipped_disabled', ts: ts(), reason: 'config_disabled', ...meta });
    return () => undefined;
  }
  if (ctx.state.toolCategory !== 'artifact_producing') {
    return () => undefined;        // silent no-op for read-only routes
  }
  if (!ctx.state.preTaskHeadSha || !ctx.state.preTaskUntrackedFiles) {
    ctx.emit({ event: 'progress_watchdog_skipped_non_git', ts: ts(), reason: 'non_git_cwd', ...meta });
    return () => undefined;
  }

  ctx.emit({ event: 'progress_watchdog_armed', ts: ts(), toolCategory: ctx.state.toolCategory, ...meta });
  const startedAtMs = Date.now();
  let warned = false;

  // Poll interval clamped to [5s, 30s]. Coarser than stall-watchdog's [1s, 5s]
  // because git diff is heavier than just checking idle time. Total cost: a
  // few git invocations per task — negligible.
  const pollIntervalMs = Math.min(30_000, Math.max(5_000, Math.floor(ctx.config.thrashWallClockMs / 60)));

  let pollInFlight = false;
  const interval = setInterval(() => {
    if (ctx.state2.fired) return;
    if (ctx.controller.signal.aborted) {
      ctx.state2.fired = true;
      return;
    }
    const wallClockMs = Date.now() - startedAtMs;
    // Cheap pre-check: only call git when we're past the soft threshold (no
    // point grepping git every 30s during the first few minutes of a task).
    if (wallClockMs < ctx.config.thrashSoftWallClockMs) return;

    if (pollInFlight) return;          // skip tick if previous diff still running
    pollInFlight = true;
    void (async () => {
      try {
        const cwd = ctx.state.cwd ?? '';
        const preSha = ctx.state.preTaskHeadSha!;
        const files = await gitDiffNameOnly(cwd, preSha);
        const diffEmpty = files.length === 0;
        if (!diffEmpty) return;        // diff is non-empty; not thrashing

        // Signal 2: soft warn (fires once per task)
        if (!warned && wallClockMs >= ctx.config.thrashSoftWallClockMs) {
          warned = true;
          ctx.emit({ event: 'progress_watchdog_warn', ts: ts(), wallClockMs, ...meta });
        }

        // Signal 1: hard thrash — wall-clock exceeded + diff still empty → abort
        if (wallClockMs >= ctx.config.thrashWallClockMs) {
          ctx.state2.fired = true;
          ctx.state.thrashingDetected = true;
          ctx.state.preStopReason = 'thrashing';
          ctx.controller.abort();
          ctx.emit({
            event: 'progress_watchdog_fired_thrash',
            ts: ts(),
            wallClockMs,
            threshold: 'wallclock',
            ...meta,
          });
        }
      } catch {
        // non-fatal: continue polling
      } finally {
        pollInFlight = false;
      }
    })();
  }, pollIntervalMs);

  return () => {
    clearInterval(interval);
    ctx.emit({
      event: 'progress_watchdog_disarmed',
      ts: ts(),
      reason: ctx.state2.fired ? 'thrash' : 'normal',
      ...meta,
    });
  };
}

/**
 * Post-hoc finalization called AFTER session.send() returns. Three things:
 *
 * 1. Turn-count thrash detection (since we can't observe turns mid-flight).
 *    If turns > thrashTurns AND real diff is empty AND watchdog didn't already
 *    trip mid-flight, mark state.thrashingDetected = true so the annotator
 *    surfaces it. No abort (the session already finished); this is informative.
 * 2. Scope-violation analysis. Compute out-of-scope files from the final diff
 *    against declared filePaths; populate state.scopeViolations[].
 * 3. Emit observability events for both.
 */
export async function recordPostHocSignals(
  state: LifecycleState,
  turnsUsed: number,
  config: ProgressWatchdogConfig,
  emit: (event: Record<string, unknown>) => void,
  taskIndex: number,
  batchId?: string,
): Promise<void> {
  if (!config.enabled) return;
  if (state.toolCategory !== 'artifact_producing') return;
  if (!state.preTaskHeadSha || !state.preTaskUntrackedFiles) return;

  const meta = {
    ...(batchId !== undefined && { batchId }),
    taskIndex,
  };
  const ts = () => new Date().toISOString();

  const realFiles = await getRealFilesChanged(state);
  if (realFiles.source !== 'git_diff') return;

  // (1) Post-hoc turn-count thrash (only if watchdog didn't already trip)
  if (!state.thrashingDetected && turnsUsed > config.thrashTurns && realFiles.files.length === 0) {
    state.thrashingDetected = true;
    emit({
      event: 'progress_watchdog_fired_thrash',
      ts: ts(),
      turnsUsed,
      threshold: 'turns_post_hoc',
      ...meta,
    });
  }

  // (2) Scope-violation analysis
  const taskSpec = state.task as { filePaths?: string[] } | undefined;
  const declaredScope: NormalizedScopeEntry[] =
    (taskSpec?.filePaths ?? []).map((entry) => normalizeScopeEntry(state.cwd ?? '', entry));
  if (declaredScope.length > 0 && realFiles.files.length > 0) {
    const violations = realFiles.files.filter((f) => !isInScope(f, declaredScope));
    if (violations.length > 0) {
      state.scopeViolations = violations;
      emit({ event: 'progress_watchdog_scope_violation', ts: ts(), outOfScope: violations, ...meta });
    }
  }
}