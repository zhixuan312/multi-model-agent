import { App } from '@modelcontextprotocol/ext-apps';
import { deriveDisplayState, type DisplayState } from './display-state.js';

/**
 * Bootstrap + full polling/cancel state machine for the execution-monitor MCP App.
 *
 * `window.__MMA_CREATE_APP__` is a test-only injection seam: when a host page (or a test
 * harness) sets it, the bootstrap uses whatever it returns instead of constructing the
 * real `App`. Production Claude Desktop never sets this, so the fallback below — the
 * vanilla `App` from `@modelcontextprotocol/ext-apps`'s `'.'` export — is the real path a
 * real host exercises.
 *
 * State machine summary (see the plan's Task I-7 contract for the full spec):
 * - `app.connect()` must resolve before anything else happens; a rejection renders
 *   `connection-error` and starts no polling.
 * - The initiating `mma_run` result arrives via `app.ontoolresult`. If it is ALREADY
 *   TERMINAL, it is rendered immediately and NO poll loop starts (no `callServerTool`
 *   call, no Cancel button). Otherwise the taskId is extracted and the first
 *   `mma_task_get` poll fires immediately.
 * - Subsequent polls run every 2000ms after the previous one settles, with at most one
 *   in flight at a time, each bounded by a 10000ms timeout counted as one failure.
 * - Five consecutive failures/timeouts stop polling and render `stopped` naming the last
 *   error.
 * - `app.ontoolresult` stays wired for the App's whole lifetime — any later delivery
 *   (not just the first) is treated as a fresh snapshot update.
 * - Cancel disables immediately on click and re-enables ONLY on a confirming
 *   `cancellationRequested` snapshot, a terminal envelope, or a defined cancel failure —
 *   never merely because the `mma_task_cancel` promise resolved.
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
 */
function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 0.01 && abs > 0) return `$${abs.toFixed(4)}`;
  return `$${abs.toFixed(2)}`;
}

/** Longest result preview the widget will show. See `renderDisplay` for why there is a cap. */
const SUMMARY_PREVIEW_CHARS = 180;

/**
 * Reduce a structured report to one short line of plain text.
 *
 * The full result is ALREADY delivered to the model as the tool result — the widget showing it
 * again is pure duplication, and these results run to thousands of characters, so it turned the
 * monitor into a wall of raw JSON that overflowed the panel. A monitor should say what happened
 * and what it cost; the answer itself belongs in the conversation.
 */
function summaryPreview(summary: unknown): string | null {
  let text: string | null = null;
  if (typeof summary === 'string') text = summary;
  else if (summary && typeof summary === 'object') {
    const record = summary as Record<string, unknown>;
    // Prefer the fields our reports actually carry over a JSON dump of the whole object.
    for (const key of ['answer', 'summary', 'finding', 'result']) {
      if (typeof record[key] === 'string') { text = record[key] as string; break; }
    }
  }
  if (text === null) return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > SUMMARY_PREVIEW_CHARS
    ? `${collapsed.slice(0, SUMMARY_PREVIEW_CHARS).trimEnd()}…`
    : collapsed;
}

function renderDisplay(display: DisplayState): string {
  if (display.mode === 'terminal') {
    const bits = [`<h2>${escapeHtml(display.status)}</h2>`];

    // One compact meta line rather than a stack of labelled rows.
    const meta: string[] = [];
    if (typeof display.totalCostUsd === 'number') {
      meta.push(`${formatUsd(display.totalCostUsd)} total`);
    }
    if (typeof display.savedVsMainCostUsd === 'number') {
      // A negative "saved" is a cost, and printing it as `Saved: $-0.05` makes the reader do
      // the sign arithmetic. Say which it was.
      const v = display.savedVsMainCostUsd;
      meta.push(v < 0 ? `${formatUsd(v)} over main` : `${formatUsd(v)} saved vs main`);
    }
    if (meta.length > 0) {
      bits.push(`<p class="meta">${escapeHtml(meta.join(' · '))}</p>`);
    }

    const preview = 'summary' in display ? summaryPreview(display.summary) : null;
    if (preview) {
      bits.push(`<p class="preview">${escapeHtml(preview)}</p>`);
      bits.push('<p class="meta">Full result is in the conversation.</p>');
    }
    return bits.join('');
  }

  const label = display.mode === 'cancelling' ? 'Cancelling' : 'Running';
  const bits = [`<h2>${label}</h2>`];
  // Omit the phase lines entirely when there is no phase yet, rather than printing a bare
  // "Phase:" with nothing after it. The very first snapshot of a run has no phase, so the
  // dangling label is what a user sees FIRST — and a label with no value reads as a failure
  // to load, not as "not started yet". Same rule already applied to runningHeadline.
  if (display.phase) {
    bits.push(`<p>Phase: ${escapeHtml(display.phase)}</p>`);
  }
  bits.push(`<p>Elapsed: ${formatDuration(display.elapsedMs)}</p>`);
  if (display.phase) {
    bits.push(`<p>Phase elapsed: ${formatDuration(display.phaseElapsedMs)}</p>`);
  }
  if (display.mode === 'running') {
    if (display.runningHeadline) {
      bits.push(`<p>${escapeHtml(display.runningHeadline)}</p>`);
    }
    if (typeof display.totalTasks === 'number') {
      bits.push(`<p>Tasks: ${display.totalTasks}</p>`);
    }
  }
  return bits.join('');
}

function bootstrap(): void {
  const root = mount();

  let currentView: ViewState = { kind: 'connecting' };
  let updateFailed = false;
  let cancelClickLock = false;
  let taskId: string | null = null;
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
      root.appendChild(button);
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
    if (stopped || taskId === null) {
      return;
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('poll timed out after 10000ms')), POLL_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([
        app.callServerTool({ name: 'mma_task_get', arguments: { taskId } }),
        timeoutPromise,
      ]);
      clearTimeout(timeoutHandle);
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
    if (cancelClickLock || taskId === null) {
      return;
    }
    cancelClickLock = true;
    if (button) {
      button.disabled = true;
    }
    try {
      await activeApp.callServerTool({ name: 'mma_task_cancel', arguments: { taskId } });
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
        // taskId and starts the poll loop; latching on a payload we failed to parse would
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
      const parsedTaskId = (parsed as Record<string, unknown>)['taskId'];
      taskId = typeof parsedTaskId === 'string' ? parsedTaskId : null;
      if (taskId !== null) {
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
