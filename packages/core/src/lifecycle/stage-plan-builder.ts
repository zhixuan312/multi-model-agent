import type { StagePlan, StageRow } from './stage-plan-types.js';
import type { ToolCategory } from '../escalation/escalation-policy.js';

export function buildStagePlan(category: ToolCategory): StagePlan {
  const isAP = category === 'artifact_producing';
  const isRO = category === 'read_only';
  // Research category has no per-row gate constant (unlike isAP/isRO). Instead,
  // explore tasks inject reviewPolicy: 'none' (explore.ts:445), which causes
  // all review-linked rows (4.1, 4.6, 4.10.x, 4.11, 5.1, 5.2) to skip —
  // reviewPolicy is the general-purpose review-skip mechanism, not per-category
  // booleans. See workflow-matrix.md appendix #4. The void expression exists
  // solely to satisfy the ESLint no-unused-vars rule for the 'category' param.

  const rows: StageRow[] = [
    // Stage 1 — Ingress (rows 1.1–1.4; spec C10 lines 1284–1290)
    { rowId: '1.1', stageName: 'accept_http_request',       runCondition: () => true, isRework: false, handlerKey: 'accept_http_request' },
    { rowId: '1.2', stageName: 'verify_loopback',           runCondition: () => true, isRework: false, handlerKey: 'verify_loopback' },
    { rowId: '1.3', stageName: 'validate_workspace',        runCondition: () => true, isRework: false, handlerKey: 'validate_workspace' },
    { rowId: '1.4', stageName: 'load_project_state',        runCondition: () => true, isRework: false, handlerKey: 'load_project_state' },

    // Stage 2 — Intake (rows 2.1–2.5; spec C10 lines 1291–1295)
    { rowId: '2.1', stageName: 'parse_brief',               runCondition: () => true, isRework: false, handlerKey: 'parse_brief' },
    { rowId: '2.2', stageName: 'verify_referenced_blocks',  runCondition: (s) => Array.isArray(s.contextBlockIds) && s.contextBlockIds.length > 0,
      isRework: false, handlerKey: 'verify_referenced_blocks' },
    { rowId: '2.3', stageName: 'apply_defaults',            runCondition: () => true, isRework: false, handlerKey: 'apply_defaults' },
    { rowId: '2.4', stageName: 'mark_intake_complete',      runCondition: () => true, isRework: false, handlerKey: 'mark_intake_complete' },
    // 2.5: prepare_execution_context — runs after intake so cwd/userMessage/systemPrompt are available
    { rowId: '2.5', stageName: 'prepare_execution_context', runCondition: () => true, isRework: false, handlerKey: 'prepare_execution_context' },

    // Stage 3 — Initial Run (row 3.1; route 'register-context-block' skips this)
    { rowId: '3.1', stageName: 'run_initial_impl', schemaStage: 'implementing',
      runCondition: (s) => !s.terminal && s.route !== 'register-context-block',
      isRework: false, handlerKey: 'run_initial_impl' },

    // 3.5: check_files_written — early-exit when artifact-producing impl wrote zero files.
    // When fired, the handler sets state.terminal=true so review chains, verify, and
    // commit short-circuit.
    {
      rowId: '3.5', stageName: 'check_files_written',
      runCondition: (s) => isAP
        && s.reviewPolicy !== 'quality_only'
        && !!s.lastRunResult
        && Array.isArray((s.lastRunResult as { filesWritten?: unknown }).filesWritten)
        && ((s.lastRunResult as { filesWritten?: unknown[] }).filesWritten?.length ?? 0) === 0
        && !s.terminal,
      isRework: false, handlerKey: 'check_files_written',
    },

    // ── Stage 4 — v4.4.x five-stage pipeline ───────────────────────────────
    //   Implementing → Review → Rework → Committing → Annotating
    //
    // 4.1: review (single complex session: spec then quality sequentially).
    //      Emits state.reviewVerdict + state.reviewConcerns.
    // 4.2: rework (standard tier, full tools, single pass). Skipped when
    //      reviewVerdict === 'approved'.
    // 4.3: committing (write routes only; per-task git commit with full
    //      gate logic: no_repo / no_diff / validation_failed /
    //      validation_stale / worker_committed_out_of_band / hook_failed).
    // 4.4: annotating (pure transform; builds the unified StructuredReport
    //      from lastRunResult + review state + commit outcome).
    { rowId: '4.1', stageName: 'review', schemaStage: 'review',
      runCondition: (s) => isAP && s.reviewPolicy !== 'none' && !s.terminal,
      isRework: false, handlerKey: 'review' },
    { rowId: '4.2', stageName: 'rework', schemaStage: 'rework',
      runCondition: (s) => isAP
        && s.reviewPolicy !== 'none'
        && s.reviewVerdict === 'changes_required'
        && !s.terminal,
      isRework: true, handlerKey: 'rework' },
    // 4.3: committing — fires before annotating so the commit outcome
    // (sha / message / skipReason) is available to the annotator's report.
    // Gate is permissive at the stage-plan level; the handler enforces
    // no_repo / no_diff / validation_failed / etc. internally.
    { rowId: '4.3', stageName: 'git_commit', schemaStage: 'committing',
      runCondition: (s) => {
        if (s.autoCommit !== true) return false;
        if (s.readOnlyTask) return false;
        if (s.terminal) return false;
        // After review: only commit when reviewer approved, or when there
        // was no review at all (reviewPolicy === 'none').
        if (s.reviewPolicy !== 'none' && s.reviewVerdict !== 'approved') return false;
        return true;
      },
      isRework: false, handlerKey: 'git_commit' },
    // 4.4: annotating — unified pure transform for read + write routes.
    { rowId: '4.4', stageName: 'annotating', schemaStage: 'annotating',
      runCondition: (s) => !s.terminal,
      isRework: false, handlerKey: 'annotating' },
    // 5.3.rcb: register_to_block_store — fires for register-context-block
    // route only, before compose_response. Sets state.blockRegistration
    // which compose_response reads to emit {id, size, ttlMs}.
    { rowId: '5.3.rcb', stageName: 'register_to_block_store',
      runCondition: (s) => s.route === 'register-context-block' && !s.terminal,
      isRework: false, handlerKey: 'register_to_block_store' },
    // 5.3: compose_response — always fires (even after terminal=true) so the
    // response envelope reflects the failure shape correctly.
    { rowId: '5.3', stageName: 'compose_response',
      runCondition: () => true, isRework: false, handlerKey: 'compose_response',
      runOnTerminal: true },
    // 5.3.5: register_terminal_block — every task except register_context_block.
    // Must fire on terminal=true so failed tasks still get a terminal context block.
    { rowId: '5.3.5', stageName: 'register_terminal_block',
      runCondition: (s) => s.route !== 'register-context-block',
      isRework: false, handlerKey: 'register_terminal_block', runOnTerminal: true },
    // 5.4: emit_task_terminal — fires the per-task terminal event after register_terminal_block
    { rowId: '5.4', stageName: 'emit_task_terminal',
      runCondition: () => true, isRework: false, handlerKey: 'emit_task_terminal',
      runOnTerminal: true },
    // 5.5: persist_to_batch_registry — always
    { rowId: '5.5', stageName: 'persist_to_batch_registry',
      runCondition: () => true, isRework: false, handlerKey: 'persist_to_batch_registry',
      runOnTerminal: true },
    // 5.6: record_task_completed — server-only; calls ctx.recorder.recordTaskCompleted
    //      to enqueue the cloud task.completed wire event. No-ops on CLI/test paths
    //      (no recorder). Must run on terminal so failures still record.
    { rowId: '5.6', stageName: 'record_task_completed',
      runCondition: () => true, isRework: false, handlerKey: 'record_task_completed',
      runOnTerminal: true },

    // Stage 6 — emit + cleanup (rows 6.1–6.3)
    // 6.1: flush_telemetry — always; fires on terminal so failure events drain
    { rowId: '6.1', stageName: 'flush_telemetry',
      runCondition: () => true, isRework: false, handlerKey: 'flush_telemetry',
      runOnTerminal: true },
    // 6.2: project_idle_cleanup_tick — TIMER-DRIVEN (per spec C14); the row exists for plan completeness
    //      but never fires from per-request iteration. Returns false so LifecycleDriver skips it.
    { rowId: '6.2', stageName: 'project_idle_cleanup_tick',
      runCondition: () => false, isRework: false, handlerKey: 'project_idle_cleanup_tick' },
    // 6.3: batch_retention_sweep_tick — TIMER-DRIVEN; same
    { rowId: '6.3', stageName: 'batch_retention_sweep_tick',
      runCondition: () => false, isRework: false, handlerKey: 'batch_retention_sweep_tick' },
  ];
  return { toolCategory: category, rows };
}

// ─── v5 STAGE_PLAN ────────────────────────────────────────────────────────────
//
// Canonical 9-stage definition array per spec §3-4. Each stage declares static
// route applicability (Layer 1: applicableRoutes) and dynamic state-level
// participation (Layer 2: shouldRun). The new driver walks this in order.

import type { StageDefinition, ImplementPayload, ReviewPayload, ReworkPayload,
              CommitPayload, AnnotatePayload, ComposePayload, TerminalPayload,
              RegisterBlockPayload } from './stage-io.js';
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
      const mod = await loadHandler(() => import('./handlers/task-executor.js'));
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
        return { run: false, comment: 'review skipped because reviewPolicy=none' };
      }
      return { run: true };
    },
    handler: async (state) => {
      const mod = await loadHandler(() => import('./handlers/review-handler.js'));
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
      const mod = await loadHandler(() => import('./handlers/rework-handler.js'));
      // reworkHandler is StageHandler-style (mutating state); wrap to emit StageGate.
      const t0 = Date.now();
      await mod.reworkHandler(state);
      const last = state.lastRunResult as { summary?: string; filesChanged?: string[]; workerStatus?: string } | undefined;
      const payload: ReworkPayload = {
        workerSelfAssessment: (last?.workerStatus === 'done' ? 'done' : 'failed'),
        summary: last?.summary ?? '',
        filesChanged: last?.filesChanged ?? [],
        unaddressedFindingIds: [],   // legacy rework doesn't surface this; filled by future LLM rework
      };
      return {
        outcome: 'advance' as const,
        payload,
        telemetry: { stageLabel: 'rework', durationMs: Date.now() - t0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
      };
    },
  },
  {
    name: 'commit',
    runOnHalt: false,
    applicableRoutes: WRITE_ROUTES_ARR as unknown as StageDefinition['applicableRoutes'],
    shouldRun: (state) => {
      if (state.autoCommit === false) {
        return { run: false, comment: 'commit skipped because autoCommit disabled' };
      }
      const work = currentWork({ gates: (state.gates ?? {}) as Record<string, import('./stage-io.js').StageGate<unknown>> });
      if (!work || (work as { filesChanged?: string[] }).filesChanged?.length === 0) {
        return { run: false, comment: 'commit skipped because no files changed' };
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
      const t0 = Date.now();
      const mod = await loadHandler(() => import('./handlers/annotator.js'));
      await mod.annotator(state);
      const annotatePayload = (state as { annotatePayload?: AnnotatePayload }).annotatePayload;
      const payload: AnnotatePayload = annotatePayload ?? {
        completed: false, message: 'annotator produced no payload',
        findings: [], summary: '', filesChanged: [], commitSha: null,
      };
      return {
        outcome: 'advance' as const,
        payload,
        telemetry: { stageLabel: 'annotate', durationMs: Date.now() - t0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
      };
    },
  },
  {
    name: 'compose',
    runOnHalt: true,
    applicableRoutes: 'all',
    shouldRun: alwaysRun,
    handler: async (state) => {
      const t0 = Date.now();
      const mod = await loadHandler(() => import('./handlers/baseline-handlers.js'));
      const composeFn = mod.buildStageHandlers({}).compose_response;
      composeFn(state);
      // The new compose path stored into state.responseEnvelope; we also expose
      // it as a StageGate<ComposePayload> for v5 consumers.
      const env = (state as { responseEnvelope?: unknown }).responseEnvelope;
      const payload: ComposePayload = env as ComposePayload ?? {
        completed: false, message: 'compose produced no envelope',
        findings: [], summary: '', filesChanged: [], commitSha: null, blockId: null,
        telemetry: {
          totalDurationMs: 0, totalCostUSD: null,
          workerSelfAssessment: null, reviewVerdict: null,
          commitOutcome: 'not_applicable', stopReason: 'transport_error',
          haltedStage: null, stages: [],
        },
      };
      return {
        outcome: 'advance' as const,
        payload,
        telemetry: { stageLabel: 'compose', durationMs: Date.now() - t0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
      };
    },
  },
  {
    name: 'terminal',
    runOnHalt: true,
    applicableRoutes: 'all',
    shouldRun: alwaysRun,
    handler: async (state) => {
      const t0 = Date.now();
      const mod = await loadHandler(() => import('./handlers/terminal-handlers.js'));
      // Invoke each terminal sub-handler in idempotency-safe order.
      const flags: TerminalPayload = {
        terminalBlockId: null,
        telemetryFlushed: false,
        batchRegistryPersisted: false,
        taskTerminalEmitted: false,
        projectCleanupTicked: false,
      };
      try {
        await mod.registerTerminalBlockHandler(state);
        flags.terminalBlockId = (state as { terminalBlockId?: string }).terminalBlockId ?? null;
      } catch { /* leave null */ }
      try {
        await mod.flushTelemetryHandler(state);
        flags.telemetryFlushed = true;
      } catch { /* leave false */ }
      try {
        await mod.persistToBatchRegistryHandler(state);
        flags.batchRegistryPersisted = true;
      } catch { /* leave false */ }
      try {
        await mod.emitTaskTerminalHandler(state);
        flags.taskTerminalEmitted = true;
      } catch { /* leave false */ }
      try {
        await mod.recordTaskCompletedHandler(state);
        flags.projectCleanupTicked = true;
      } catch { /* leave false */ }
      return {
        outcome: 'advance' as const,
        payload: flags,
        telemetry: { stageLabel: 'terminal', durationMs: Date.now() - t0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
      };
    },
  },
];
