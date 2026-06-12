// ─── v5 STAGE_PLAN ────────────────────────────────────────────────────────────
//
// Canonical 9-stage definition array per spec §3-4. Each stage declares static
// route applicability (Layer 1: applicableRoutes) and dynamic state-level
// participation (Layer 2: shouldRun). The new driver walks this in order.

import type { StageDefinition } from './stage-io.js';
import { ALL_TASK_ROUTES, WRITE_ROUTES } from './stage-io.js';

// We import handler functions where they exist as exports; this is fine for
// modules with no circular deps. Where the v5 handler is gated to opt-in,
// the wrapper falls back to a no-op.
import { prepareExecutionContextHandler } from './handlers/prepare-execution-context-handler.js';
import { registerToBlockStoreHandler } from './handlers/register-context-block-handlers.js';
import { checkGitPreconditions } from './goal-preconditions.js';
import type { Goal } from '../types/goal.js';

const ALL_TASK_ROUTES_ARR: readonly string[] = ALL_TASK_ROUTES;
const WRITE_ROUTES_ARR: readonly string[] = WRITE_ROUTES;

function alwaysRun(): { run: true } { return { run: true }; }

// Lazy import to avoid bootstrap-time circular deps.
async function loadHandler<T>(loader: () => Promise<T>): Promise<T> {
  return await loader();
}

/** v5 canonical stage plan — single source of truth for stage order + gates. */
export const STAGE_PLAN: StageDefinition<unknown>[] = [
  {
    name: 'prepare',
    runOnHalt: false,
    applicableRoutes: 'all',
    shouldRun: alwaysRun,
    handler: async (state) => {
      const t0 = Date.now();
      try {
        await prepareExecutionContextHandler(state);
        // Goal mode (write routes): run git preconditions + capture baseSha
        // INSIDE the write-goal lock (the whole dispatch is locked), before any
        // implement send. A failed precondition halts before phase 1.
        const goal = (state.task as { goal?: Goal } | undefined)?.goal;
        if (goal) {
          const pre = await checkGitPreconditions(goal);
          if (!pre.ok) {
            // Surface the precondition code as a proper failed result so the
            // dispatcher returns it (not the generic runner_crash fallback) and
            // the batch completes with a well-formed failed task.
            (state as { lastRunResult?: unknown }).lastRunResult = {
              output: '', status: 'error',
              usage: { inputTokens: 0, outputTokens: 0 },
              turns: 0, filesWritten: [], outputIsDiagnostic: true, escalationLog: [],
              error: pre.message, errorCode: 'other',
              structuredError: { code: pre.code, message: pre.message, where: 'goal-precondition' },
              workerStatus: 'failed',
            };
            return {
              outcome: 'halt',
              comment: `${pre.code}: ${pre.message}`,
              payload: null,
              telemetry: { stageLabel: 'prepare', durationMs: Date.now() - t0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
            };
          }
          (state as { goalBaseSha?: string }).goalBaseSha = pre.baseSha;
          (state as { preTaskHeadSha?: string }).preTaskHeadSha = pre.baseSha;
        }
        return {
          outcome: 'advance',
          payload: null,
          telemetry: { stageLabel: 'prepare', durationMs: Date.now() - t0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /brief schema|invalid brief/i.test(msg) ? 'brief_invalid'
                   : /workspace|traversal|sandbox/i.test(msg) ? 'workspace_violation'
                   : /context_block|missing/i.test(msg) ? 'context_block_missing'
                   : 'prepare_failed';
        return {
          outcome: 'halt',
          comment: `${code}: ${msg}`,
          payload: null,
          telemetry: { stageLabel: 'prepare', durationMs: Date.now() - t0, costUSD: 0, turnsUsed: 0, stopReason: 'transport_error' },
        };
      }
    },
  },
  {
    name: 'register-block',
    runOnHalt: false,
    applicableRoutes: ['register-context-block'],
    shouldRun: alwaysRun,
    handler: async (state) => {
      return await registerToBlockStoreHandler(state);
    },
  },
  {
    name: 'implement',
    runOnHalt: false,
    applicableRoutes: ALL_TASK_ROUTES_ARR as unknown as StageDefinition['applicableRoutes'],
    shouldRun: alwaysRun,
    handler: async (state) => {
      const mod = await loadHandler(() => import('./handlers/implement-stage.js'));
      return mod.implementHandler(state);
    },
  },
  {
    // Goal mode phase 2: review-fix. One autonomous send on the configured
    // phase-2 tier reviews each task's commit and self-commits fixes. Replaces
    // the old review→rework→commit trio (write-routes-only); read routes skip
    // it exactly as before.
    name: 'review',
    runOnHalt: false,
    applicableRoutes: WRITE_ROUTES_ARR as unknown as StageDefinition['applicableRoutes'],
    shouldRun: (state) => {
      const impl = state.gates?.['implement'];
      if (impl?.outcome !== 'advance') {
        return { run: false, comment: 'review-fix skipped because implement did not advance' };
      }
      const task = state.task as { goal?: unknown } | undefined;
      if (!task?.goal) {
        return { run: false, comment: 'review-fix skipped: no goal on task' };
      }
      if (state.reviewPolicy === 'none') {
        return { run: false, comment: 'review-fix skipped because reviewPolicy=none', skipReason: 'reviewPolicy_none' };
      }
      return { run: true };
    },
    handler: async (state) => {
      const mod = await loadHandler(() => import('./handlers/review-fix-stage.js'));
      return mod.reviewFixHandler(state);
    },
  },
  {
    name: 'annotate',
    runOnHalt: false,
    applicableRoutes: ALL_TASK_ROUTES_ARR as unknown as StageDefinition['applicableRoutes'],
    shouldRun: alwaysRun,
    handler: async (state) => {
      const mod = await loadHandler(() => import('./handlers/annotate-stage.js'));
      return mod.annotator(state);
    },
  },
  {
    name: 'compose',
    runOnHalt: true,
    applicableRoutes: 'all',
    shouldRun: alwaysRun,
    handler: async (state) => {
      const mod = await loadHandler(() => import('./handlers/baseline-handlers.js'));
      return mod.composeHandler(state);
    },
  },
  {
    name: 'terminal',
    runOnHalt: true,
    applicableRoutes: 'all',
    shouldRun: alwaysRun,
    handler: async (state) => {
      const mod = await loadHandler(() => import('./handlers/terminal-handlers.js'));
      return mod.terminalHandler(state);
    },
  },
];
