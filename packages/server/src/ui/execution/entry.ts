import { App } from '@modelcontextprotocol/ext-apps';
import { deriveDisplayState, type DisplayState } from './display-state.js';
import { sceneSvg, sceneClass, type Act } from './scene.js';

/**
 * Bootstrap + full polling/cancel state machine for the execution-monitor MCP App.
 *
 * `window.__MMA_CREATE_APP__` is a test-only injection seam: when a host page (or a test
 * harness) sets it, the bootstrap uses whatever it returns instead of constructing the
 * real `App`. Production Claude Desktop never sets this, so the fallback below — the
 * vanilla `App` from `@modelcontextprotocol/ext-apps`'s `'.'` export — is the real path a
 * real host exercises.
 *
 * State machine summary:
 * - `app.connect()` must resolve before anything else happens; a rejection renders
 *   `connection-error` and starts no polling.
 * - The initiating `mma_run` result arrives via `app.ontoolresult`. If it is ALREADY
 *   TERMINAL, it is rendered immediately and NO poll loop starts (no `callServerTool`
 *   call, no Cancel button). Otherwise the executionId is extracted and the first
 *   `mma_execution_get` poll fires immediately.
 * - Subsequent polls run every 2000ms after the previous one settles, with at most one
 *   in flight at a time, each bounded by a 10000ms timeout counted as one failure.
 * - Five consecutive failures/timeouts stop polling and render `stopped` naming the last
 *   error.
 * - `app.ontoolresult` stays wired for the App's whole lifetime — any later delivery
 *   (not just the first) is treated as a fresh snapshot update.
 * - Cancel disables immediately on click and re-enables ONLY on a confirming
 *   `cancellationRequested` snapshot, a terminal envelope, or a defined cancel failure —
 *   never merely because the `mma_execution_cancel` promise resolved.
 */

interface CallToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface AppLike {
  connect(): Promise<void>;
  ontoolresult: ((params: unknown) => void) | undefined;
  callServerTool(params: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult>;
}

declare global {
  interface Window {
    __MMA_CREATE_APP__?: () => AppLike;
  }
}

function createApp(): AppLike {
  if (typeof window !== 'undefined' && window.__MMA_CREATE_APP__) {
    return window.__MMA_CREATE_APP__();
  }
  return new App({ name: 'mma-execution-monitor', version: '1.0.0' }, {}) as unknown as AppLike;
}

function mount(): HTMLElement {
  const root = document.getElementById('app');
  if (!root) {
    throw new Error('execution App bootstrap: missing #app mount point');
  }
  // Follow the host's light/dark theme via its CSS custom properties rather than hardcoding
  // colours — but always WITH a fallback. A host is not obliged to define these, and Claude
  // Desktop does not: a bare `var(--color-text-primary)` is invalid at computed-value time
  // there, so the text renders initial-black on a dark panel in the default serif face.
  // `CanvasText` (paired with `color-scheme` in the stylesheet) tracks the host's light/dark
  // mode, so the untheme case has real contrast rather than merely being visible.
  // `--mma-ink` is defined by the bundle's own stylesheet and flips with
  // prefers-color-scheme, so this resolves to readable text whether or not the host themes
  // us. Inline styles beat the stylesheet, so the fallback chain must match it exactly.
  root.style.color = 'var(--color-text-primary, var(--mma-ink))';
  root.style.fontFamily = 'var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif)';
  return root;
}

type ViewState =
  | { kind: 'connecting' }
  | { kind: 'connection-error' }
  | { kind: 'stopped'; lastError: string | null }
  | { kind: 'display'; display: DisplayState };

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 5;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * Render a duration for humans. Raw milliseconds are fine at 200ms and useless at 7065ms —
 * and this monitor exists precisely for the long tasks, where a run reads as "1847293ms".
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Money, for reading rather than for auditing. Raw floats leak straight out of the cost
 * arithmetic — `$-0.046495574999999995` is a real observed value — and eighteen decimal places
 * of binary-float noise reads as a bug even when the number is right. Sub-cent amounts keep
 * more precision, because rounding those to `$0.00` would be worse than useless.
 *
 * MAGNITUDE ONLY — the sign is dropped. The one caller that can pass a negative labels the
 * direction itself (`Over main` vs `Saved vs main`), so `Over main $-0.05` would state it
 * twice. A caller that shows this number WITHOUT such a label must carry the sign some other
 * way, or it is simply lost.
 */
function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 0.01 && abs > 0) return `$${abs.toFixed(4)}`;
  return `$${abs.toFixed(2)}`;
}

/** Compact token count: 2864079 -> "2.9M", 37007 -> "37K". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * The act the stage should play.
 *
 * Terminal is Act III regardless of the phase it stopped in; otherwise the engine's own
 * two-phase pipeline supplies the act directly.
 */
function actOf(display: DisplayState): Act {
  if (display.mode === 'terminal') return 'end';
  return display.phase === 'reviewing' ? 'review' : 'work';
}

/**
 * Heading text — `<type> · <state>`, so a panel names itself before it describes itself.
 *
 * BOTH HALVES ARE LOWERCASE, deliberately. They are the engine's own vocabulary: `spec` is
 * literally the string you pass as `type`, and `done` / `failed` are literally the envelope's
 * `task.status`. Capitalising one side produced `spec · Running` while a finished run read
 * `investigate · done` — the same heading disagreeing with itself in two directions, because
 * the running words were hardcoded here and the terminal ones came from the wire untouched.
 * Title-casing instead would misrepresent them as prose and mangle `done_with_concerns`.
 *
 * Underscores become spaces, and nothing else is transformed: `done with concerns` reads as
 * English while staying recognisably the status it came from.
 */
function headingText(display: DisplayState): string {
  const state = display.mode === 'terminal'
    ? display.status.replace(/_/g, ' ')
    : display.mode === 'cancelling' ? 'cancelling' : 'running';
  return display.taskType ? `${display.taskType} · ${state}` : state;
}

/**
 * Draw the run's activity from the series the ENGINE supplied.
 *
 * Nothing is accumulated here. The panel used to build this from the polls it personally
 * observed, so a re-mounted panel started blank, two viewers of the same task disagreed, and a
 * panel opened on an already-finished run had no history at all — the run's shape died with
 * the widget. It is a fact about the run, so the engine owns it.
 *
 * Renders NOTHING when there is no series. An empty strip element still carries the baseline
 * border, and a lone horizontal rule reads as a strip that failed to draw rather than a run
 * that has not done anything yet.
 */
function renderStrip(display: DisplayState): string {
  const counts = display.activity;
  if (!counts || counts.length === 0) return '';
  const phases = display.activityPhases ?? [];
  const max = Math.max(3, ...counts);
  const cells = counts.map((n, i) => {
    const act = phases[i] === 2 ? 2 : 1;
    const h = n === 0 ? 9 : 16 + (n / max) * 84;
    const seam = i > 0 && phases[i - 1] === 1 && act === 2
      ? `<i class="seam" style="left:${((i / counts.length) * 100).toFixed(2)}%"></i>` : '';
    return `${seam}<span class="bar ${n === 0 ? 'q' : `p${act}`}" style="height:${h.toFixed(1)}%"></span>`;
  }).join('');
  return `<div class="strip">${cells}</div>`;
}

function renderDisplay(display: DisplayState): string {
  const act = actOf(display);
  const bits: string[] = [];

  // ── row 0: header. `<h2>` carries the type and state together. ──────────────
  bits.push('<div class="hd">');
  bits.push(`<h2>${escapeHtml(headingText(display))}</h2>`);
  if (display.mode !== 'terminal') {
    const clock = display.phase
      ? `${formatDuration(display.elapsedMs)} <s>/ ${formatDuration(display.phaseElapsedMs)} in act</s>`
      : formatDuration(display.elapsedMs);
    bits.push(`<span class="clk">${clock}</span>`);
  } else if (typeof display.totalDurationMs === 'number') {
    bits.push(`<span class="clk">${formatDuration(display.totalDurationMs)}</span>`);
  }
  bits.push('</div>');

  // ── row 1: the stage, plus the live rail. Identical shape in all three acts, and the
  //    stage box is a FIXED size — a scene stretched to match a taller neighbour is a
  //    distorted frame, which is what made the terminal card read as overlong. ──────────
  const ending = display.mode === 'terminal' ? display.ending : undefined;
  const scene = { ...(display.type ? { type: display.type } : {}), act, ...(ending ? { ending } : {}) };
  bits.push('<div class="bd">');
  bits.push(
    `<div class="stage"><svg class="${sceneClass(scene)}" viewBox="0 0 52 30" `
    + `preserveAspectRatio="xMidYMax meet" fill="none" aria-hidden="true">${sceneSvg(scene)}</svg></div>`,
  );
  bits.push('<div class="rail">');
  bits.push(renderStrip(display));
  if (display.mode !== 'terminal') {
    const headline = display.mode === 'running' ? display.runningHeadline : 'recalling the worker…';
    bits.push(`<p class="now"><i class="dot"></i><span>${escapeHtml(headline ?? 'working…')}</span></p>`);
    if (display.mode === 'running' && typeof display.totalTasks === 'number') {
      bits.push(`<p class="now"><span>Tasks: ${display.totalTasks}</span></p>`);
    }
  }
  bits.push('</div></div>');

  // ── row 2: the results table, full width. Only in Act III. ──────────────────
  if (display.mode === 'terminal') {
    const cells: string[] = [];
    const cell = (k: string, v: string, cls = '') =>
      cells.push(`<div class="cel"><span class="k">${escapeHtml(k)}</span><span class="v ${cls}">${escapeHtml(v)}</span></div>`);

    if (typeof display.totalDurationMs === 'number') cell('Duration', formatDuration(display.totalDurationMs));
    if (typeof display.totalCostUsd === 'number') cell('Cost', formatUsd(display.totalCostUsd));
    if (typeof display.savedVsMainCostUsd === 'number') {
      // Shown signed and honestly. A negative saving is the one number that says delegation
      // is not paying off here, so hiding it would make the panel marketing.
      const v = display.savedVsMainCostUsd;
      cell(v < 0 ? 'Over main' : 'Saved vs main', formatUsd(v), v < 0 ? 'bad' : 'good');
    }
    const stagePart = (name: string, s: { durationMs?: number; costUsd?: number } | undefined) => {
      if (!s) return;
      const parts: string[] = [];
      if (typeof s.costUsd === 'number') parts.push(formatUsd(s.costUsd));
      if (typeof s.durationMs === 'number') parts.push(formatDuration(s.durationMs));
      if (parts.length > 0) cell(name, parts.join(' · '));
    };
    stagePart('Implementer', display.implementer);
    stagePart('Reviewer', display.reviewer);
    if (typeof display.tokensIn === 'number' || typeof display.tokensOut === 'number') {
      const parts: string[] = [];
      if (typeof display.tokensIn === 'number') parts.push(`${formatTokens(display.tokensIn)} in`);
      if (typeof display.tokensOut === 'number') parts.push(`${formatTokens(display.tokensOut)} out`);
      if (typeof display.tokensCached === 'number') parts.push(`${formatTokens(display.tokensCached)} cached`);
      cell('Tokens', parts.join(' · '));
    }
    if (typeof display.filesChanged === 'number') cell('Files changed', String(display.filesChanged));
    if (cells.length > 0) bits.push(`<div class="tbl">${cells.join('')}</div>`);
  }

  // ── row 3: meta. Anchored right so the task ref lines up with the table's right edge. ──
  if (display.taskRef) {
    bits.push(`<div class="sub"><span class="l"></span><span class="r meta">execution ${escapeHtml(display.taskRef)}</span></div>`);
  }
  return bits.join('');
}

function bootstrap(): void {
  const root = mount();

  let currentView: ViewState = { kind: 'connecting' };
  let updateFailed = false;
  let cancelClickLock = false;
  let executionId: string | null = null;
  let initiated = false;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  function render(): void {
    const parts: string[] = [];
    if (updateFailed) {
      parts.push('<p role="status">update failed — showing last known state</p>');
    }
    switch (currentView.kind) {
      case 'connecting':
        parts.push('<p>Connecting…</p>');
        break;
      case 'connection-error':
        parts.push('<p>Connection error</p>');
        break;
      case 'stopped':
        parts.push(`<p>Polling stopped — last error: ${escapeHtml(currentView.lastError ?? 'unknown error')}</p>`);
        break;
      case 'display':
        parts.push(renderDisplay(currentView.display));
        break;
    }
    root.innerHTML = parts.join('');

    if (currentView.kind === 'display' && currentView.display.mode === 'running') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Cancel';
      button.disabled = cancelClickLock;
      button.addEventListener('click', onCancelClick);
      // The stop control belongs beside the run's identity and clock, not buried under the
      // live data it would stop. Falls back to the root when the header is absent.
      (root.querySelector('.hd') ?? root).appendChild(button);
    }
  }

  function parseToolResult(result: unknown): unknown {
    if (
      typeof result === 'object' &&
      result !== null &&
      Array.isArray((result as CallToolResult).content) &&
      typeof (result as CallToolResult).content[0]?.text === 'string'
    ) {
      return JSON.parse((result as CallToolResult).content[0].text);
    }
    throw new Error('unparseable tool result');
  }

  function parseSnapshot(raw: unknown): { parsed: unknown; derived: DisplayState } | null {
    try {
      const parsed = parseToolResult(raw);
      const derived = deriveDisplayState(parsed);
      return { parsed, derived };
    } catch {
      return null;
    }
  }

  function stopPolling(): void {
    stopped = true;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function applySnapshot(raw: unknown): void {
    const result = parseSnapshot(raw);
    if (!result) {
      updateFailed = true;
      render();
      return;
    }
    updateFailed = false;
    const { parsed, derived } = result;
    currentView = { kind: 'display', display: derived };
    render();

    const rawObj = parsed as Record<string, unknown>;
    if (derived.mode === 'terminal' || rawObj['cancellationRequested'] === true) {
      cancelClickLock = false;
    }
    if (derived.mode === 'terminal') {
      stopPolling();
    }
  }

  async function pollOnce(app: AppLike): Promise<void> {
    if (stopped || executionId === null) {
      return;
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('poll timed out after 10000ms')), POLL_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([
        app.callServerTool({ name: 'mma_execution_get', arguments: { executionId } }),
        timeoutPromise,
      ]);
      clearTimeout(timeoutHandle);
      // An `isError` result is a FAILED poll, not a snapshot that happens to describe an
      // error — `mcp-adapter.ts`'s `errorResult` answers this for an executionId the registry
      // evicted, and a daemon that keeps answering it will never produce another snapshot. So
      // it is counted, capped and named like any other poll failure, rather than leaving the
      // panel in `update failed` forever with the reason nowhere on screen. `isError` was
      // declared on the interface above and read by nothing before this.
      if ((result as CallToolResult).isError === true) {
        throw new Error((result as CallToolResult).content[0]!.text);
      }
      failureCount = 0;
      applySnapshot(result);
    } catch (err) {
      clearTimeout(timeoutHandle);
      failureCount += 1;
      lastError = err instanceof Error ? err.message : String(err);
      if (failureCount >= MAX_CONSECUTIVE_FAILURES) {
        stopPolling();
        currentView = { kind: 'stopped', lastError };
        render();
        return;
      }
      // Below the cap the last-known snapshot stays on screen, but say so — a silently
      // frozen view is indistinguishable from a task that simply stopped progressing.
      updateFailed = true;
      render();
    }
    if (!stopped) {
      pollTimer = setTimeout(() => {
        void pollOnce(app);
      }, POLL_INTERVAL_MS);
    }
  }

  let failureCount = 0;
  let lastError: string | null = null;

  async function onCancelClick(event: MouseEvent): Promise<void> {
    const button = event.currentTarget as HTMLButtonElement | null;
    if (cancelClickLock || executionId === null) {
      return;
    }
    cancelClickLock = true;
    if (button) {
      button.disabled = true;
    }
    try {
      await activeApp.callServerTool({ name: 'mma_execution_cancel', arguments: { executionId } });
      // Resolution alone does NOT re-enable Cancel — only a confirming snapshot, a
      // terminal envelope, or a defined cancel failure (the catch branch below) does.
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      cancelClickLock = false;
      render();
    }
  }

  function handleIncomingResult(raw: unknown): void {
    if (!initiated) {
      const result = parseSnapshot(raw);
      if (!result) {
        // Do NOT latch `initiated` here. This branch is the only one that extracts the
        // executionId and starts the poll loop; latching on a payload we failed to parse would
        // route every later delivery to the update path, leaving the App connected,
        // rendering, and polling nothing — inert, with nothing thrown and no visible cause.
        updateFailed = true;
        render();
        return;
      }
      initiated = true;
      updateFailed = false;
      const { parsed, derived } = result;
      currentView = { kind: 'display', display: derived };
      render();
      if (derived.mode === 'terminal') {
        return;
      }
      const parsedExecutionId = (parsed as Record<string, unknown>)['executionId'];
      executionId = typeof parsedExecutionId === 'string' ? parsedExecutionId : null;
      if (executionId !== null) {
        void pollOnce(activeApp);
      }
      return;
    }
    applySnapshot(raw);
  }

  render();

  const activeApp = createApp();
  activeApp.ontoolresult = handleIncomingResult;

  void activeApp
    .connect()
    .then(() => {
      // Connection established; still waiting for the initiating mma_run result via
      // ontoolresult before rendering anything else.
    })
    .catch(() => {
      currentView = { kind: 'connection-error' };
      render();
    });
}

bootstrap();
