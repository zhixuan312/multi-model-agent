import type { StagePlan, StageRow, LifecycleState } from './stage-plan-types.js';
import type { ToolCategory } from '../escalation/escalation-policy.js';

/**
 * Helper for the `reviewPolicy === 'none'` commit path (pipeline-redesign §2.5).
 * When reviewPolicy is 'none', stages 2–4 are skipped, so state.commitGatePercent
 * is undefined when the commit gate runs. This helper returns 100 if files were
 * written (so the gate trivially passes) or 0 otherwise. Same code path as the
 * LLM-mediated case — just emits a deterministic value when annotation didn't run.
 */
function deriveBypassCommitPercent(s: LifecycleState): number {
  if (s.reviewPolicy !== 'none') return 0;
  const last = s.lastRunResult as { filesWritten?: unknown } | undefined;
  const writes = last?.filesWritten;
  return Array.isArray(writes) && writes.length > 0 ? 100 : 0;
}

export function buildStagePlan(category: ToolCategory): StagePlan {
  const isAP = category === 'artifact_producing';
  const isRO = category === 'read_only';
  // Research category has no per-row gate constant (unlike isAP/isRO). Instead,
  // explore tasks inject reviewPolicy: 'none' (explore.ts:445), which causes
  // all review-linked rows (4.1, 4.6, 4.10.x, 4.11, 5.1, 5.2) to skip —
  // reviewPolicy is the general-purpose review-skip mechanism, not per-category
  // booleans. See workflow-matrix.md appendix #4. The void expression exists
  // solely to satisfy the ESLint no-unused-vars rule for the 'category' param.
  void (category === 'research');

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

    // ── Stage 4 — Pipeline-redesign review-and-fix + annotate (4.3.0+) ─────
    // Replaces the old 11-stage spec/quality/diff/verify chain. See pipeline
    // redesign spec §2 + §3.1. Three new rows:
    //   4.1: spec_review_and_fix    — complex tier, full tools, fixes inline
    //   4.2: quality_review_and_fix — complex tier, full tools, fixes inline
    //   4.3: annotate_completion    — standard tier, readonly, structured JSON
    // Single pass each (no rework rounds). Verify command runs inside 4.3.

    // 4.1: spec review + fix — only for reviewPolicy='full'. Complex tier with
    // full tools fixes plan-fidelity gaps directly. Read-only routes (which
    // never have a "plan" to compare against) skip this entirely.
    { rowId: '4.1', stageName: 'spec_review_and_fix', schemaStage: 'spec_review',
      runCondition: (s) => isAP && s.reviewPolicy === 'full' && !s.terminal,
      isRework: false, handlerKey: 'spec_review_and_fix' },

    // 4.2: quality review + fix — for reviewPolicy in {full, quality_only}.
    // Same complex tier with full tools; fixes safety / correctness / edge
    // cases. Skipped for diff_only and none.
    { rowId: '4.2', stageName: 'quality_review_and_fix', schemaStage: 'quality_review',
      runCondition: (s) => isAP
        && (s.reviewPolicy === 'full' || s.reviewPolicy === 'quality_only')
        && !s.terminal,
      isRework: false, handlerKey: 'quality_review_and_fix' },

    // 4.3: annotate completion — for any reviewPolicy except 'none'. Standard
    // tier with readonly tools. Runs verifyCommand deterministically first,
    // then invokes annotator LLM. Sets state.completionAnnotation and
    // state.commitGatePercent. Read-only routes use the existing parallel-
    // criteria + annotator path (separate dispatcher), so they also skip 4.3.
    { rowId: '4.3', stageName: 'annotate_completion', schemaStage: 'quality_review',
      runCondition: (s) => isAP
        && s.reviewPolicy !== 'none'
        && !s.terminal,
      isRework: false, handlerKey: 'annotate_completion' },
    // 5.2: git_commit — fires when autoCommit + worker wrote files +
    // !readOnlyTask + !terminal AND commitGatePercent ≥ completionThreshold.
    //
    // 4.3.0 (pipeline redesign §2.5, §3.1): replaces the binary "reviews
    // passed" gate with a threshold check. state.commitGatePercent is set by
    // annotate_completion (row 4.3) for reviewPolicy in {full, quality_only,
    // diff_only}. For reviewPolicy='none', stages 4.1/4.2/4.3 are skipped, so
    // commitGatePercent is undefined; deriveBypassCommitPercent returns 100
    // when files were written (else 0) — uniform code path, single threshold.
    { rowId: '5.2', stageName: 'git_commit', schemaStage: 'committing',
      runCondition: (s) => {
        if (s.autoCommit !== true) return false;
        const last = s.lastRunResult as { filesWritten?: unknown } | undefined;
        const writes = last?.filesWritten;
        if (!Array.isArray(writes) || writes.length === 0) return false;
        if (s.readOnlyTask) return false;
        if (s.terminal) return false;
        const percent = s.commitGatePercent ?? deriveBypassCommitPercent(s);
        return percent >= (s.completionThreshold ?? 80);
      },
      isRework: false, handlerKey: 'git_commit' },
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
