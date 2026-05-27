// ─── v5 STAGE_PLAN ────────────────────────────────────────────────────────────
//
// Canonical 9-stage definition array per spec §3-4. Each stage declares static
// route applicability (Layer 1: applicableRoutes) and dynamic state-level
// participation (Layer 2: shouldRun). The new driver walks this in order.

import type { StageDefinition, ReviewPayload } from './stage-io.js';
import { ALL_TASK_ROUTES, WRITE_ROUTES, currentWork } from './stage-io.js';

// We import handler functions where they exist as exports; this is fine for
// modules with no circular deps. Where the v5 handler is gated to opt-in,
// the wrapper falls back to a no-op.
import { prepareExecutionContextHandler } from './handlers/prepare-execution-context-handler.js';
import { registerToBlockStoreHandler } from './handlers/register-context-block-handlers.js';

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
    name: 'review',
    runOnHalt: false,
    applicableRoutes: WRITE_ROUTES_ARR as unknown as StageDefinition['applicableRoutes'],
    shouldRun: (state) => {
      const impl = state.gates?.['implement'];
      if (impl?.outcome !== 'advance') {
        return { run: false, comment: 'review skipped because implement did not advance' };
      }
      if (state.reviewPolicy === 'none') {
        return { run: false, comment: 'review skipped because reviewPolicy=none', skipReason: 'reviewPolicy_none' };
      }
      return { run: true };
    },
    handler: async (state) => {
      const mod = await loadHandler(() => import('./handlers/review-stage.js'));
      return mod.reviewHandler(state);
    },
  },
  {
    name: 'rework',
    runOnHalt: false,
    applicableRoutes: WRITE_ROUTES_ARR as unknown as StageDefinition['applicableRoutes'],
    shouldRun: (state) => {
      const review = state.gates?.['review'];
      if (review?.outcome !== 'advance') {
        return { run: false, comment: 'rework skipped because review did not produce a verdict' };
      }
      const verdict = (review.payload as ReviewPayload | null)?.verdict;
      if (verdict === 'approved') {
        return { run: false, comment: 'rework skipped because review approved' };
      }
      return { run: true };
    },
    handler: async (state) => {
      const mod = await loadHandler(() => import('./handlers/rework-stage.js'));
      return mod.reworkHandler(state);
    },
  },
  {
    name: 'commit',
    runOnHalt: false,
    applicableRoutes: WRITE_ROUTES_ARR as unknown as StageDefinition['applicableRoutes'],
    shouldRun: (state) => {
      // Run whenever implementation work advanced. We deliberately do NOT
      // pre-skip on the worker's self-reported filesChanged (currentWork) —
      // cheap workers under-report their writes, which previously caused the
      // gate to skip while git actually had changes, so real work went
      // uncommitted. The commit handler is the single authority on
      // commit-vs-no_op: it uses getRealFilesChanged() (git diff + untracked)
      // and returns no_op:no_diff when nothing genuinely changed.
      const work = currentWork({ gates: (state.gates ?? {}) as Record<string, import('./stage-io.js').StageGate<unknown>> });
      if (!work) {
        return { run: false, comment: 'commit skipped because no implementation work advanced' };
      }
      return { run: true };
    },
    handler: async (state) => {
      const mod = await loadHandler(() => import('./handlers/git-commit-handler.js'));
      return mod.commitHandler(state);
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
