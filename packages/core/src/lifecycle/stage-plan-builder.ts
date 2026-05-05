import type { StagePlan, StageRow, LifecycleState } from './stage-plan-types.js';
import type { ToolCategory } from '../escalation/escalation-policy.js';

export function buildStagePlan(category: ToolCategory): StagePlan {
  const isAP = category === 'artifact_producing';
  const isRO = category === 'read_only';
  // research category is referenced for symmetry with isAP/isRO; rows that
  // need to gate on it (none today) would do so explicitly via toolCategory.
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
    // Mirrors current reviewed-lifecycle.ts:1211–1232 behavior. When fired, the handler
    // sets state.terminal=true so review chains, verify, and commit short-circuit.
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

    // Stage 4 — Spec chain (rows 4.1–4.5; artifact-producing + reviewPolicy='full' only)
    // 4.1: spec_review_round_1 — fires when reviewPolicy='full'
    { rowId: '4.1', stageName: 'spec_review_round_1', schemaStage: 'spec_review',
      runCondition: (s) => isAP && s.reviewPolicy === 'full' && !s.terminal,
      isRework: false, handlerKey: 'spec_review_round_1' },
    // 4.2: rework_for_spec_round_1 — fires when round_1 verdict=changes_required
    { rowId: '4.2', stageName: 'rework_for_spec_round_1', schemaStage: 'spec_rework',
      runCondition: (s) => isAP && s.specReviewRound1Verdict === 'changes_required' && !s.terminal,
      isRework: true, handlerKey: 'rework_for_spec_round_1' },
    // 4.3: spec_review_round_2 — fires when round_1 verdict=changes_required (cascade)
    { rowId: '4.3', stageName: 'spec_review_round_2', schemaStage: 'spec_review',
      runCondition: (s) => isAP && s.specReviewRound1Verdict === 'changes_required' && !s.terminal,
      isRework: false, handlerKey: 'spec_review_round_2' },
    // 4.4: rework_for_spec_round_2 (rotates tier per C9) — fires when round_2 verdict=changes_required
    { rowId: '4.4', stageName: 'rework_for_spec_round_2', schemaStage: 'spec_rework',
      runCondition: (s) => isAP && s.specReviewRound2Verdict === 'changes_required' && !s.terminal,
      isRework: true, handlerKey: 'rework_for_spec_round_2' },
    // 4.5: spec_review_round_3 — final spec attempt
    { rowId: '4.5', stageName: 'spec_review_round_3', schemaStage: 'spec_review',
      runCondition: (s) => isAP && s.specReviewRound2Verdict === 'changes_required' && !s.terminal,
      isRework: false, handlerKey: 'spec_review_round_3' },
    // 4.5.x: settle_spec_chain — sets state.specChainPassed per spec § C10.
    // runOnTerminal: settle still fires after a hard-fail in the chain so
    // chain-pass slots get authoritative values for compose_response.
    { rowId: '4.5.x', stageName: 'settle_spec_chain',
      runCondition: (s) => isAP && s.reviewPolicy === 'full',
      isRework: false, handlerKey: 'settle_spec_chain', runOnTerminal: true },

    // Stage 4 — Quality chain (rows 4.6–4.10; artifact-producing OR read-only annotator path)
    // 4.6: quality_review_round_1 — fires when reviewPolicy in {full, quality_only} AND
    //      (artifact_producing AND spec passed OR n/a) OR read_only (no spec chain to gate on).
    //      For read-only tools this is the AnnotatorEngine pass; verdict will be 'annotated'.
    { rowId: '4.6', stageName: 'quality_review_round_1', schemaStage: 'quality_review',
      runCondition: (s) => (isAP || isRO)
        && (s.reviewPolicy === 'full' || s.reviewPolicy === 'quality_only')
        && (isRO || s.reviewPolicy !== 'full' || s.specChainPassed === true)
        && !s.terminal,
      isRework: false, handlerKey: 'quality_review_round_1' },
    // 4.7: rework_for_quality_round_1 — gated on changes_required (matches reviewer
    // output; 'concerns' is removed from the verdict union — no reviewer emits it).
    // Annotator output 'annotated' naturally fails this gate.
    { rowId: '4.7', stageName: 'rework_for_quality_round_1', schemaStage: 'quality_rework',
      runCondition: (s) => isAP && s.qualityReviewRound1Verdict === 'changes_required' && !s.terminal,
      isRework: true, handlerKey: 'rework_for_quality_round_1' },
    // 4.8: quality_review_round_2
    { rowId: '4.8', stageName: 'quality_review_round_2', schemaStage: 'quality_review',
      runCondition: (s) => isAP && s.qualityReviewRound1Verdict === 'changes_required' && !s.terminal,
      isRework: false, handlerKey: 'quality_review_round_2' },
    // 4.9: rework_for_quality_round_2 (rotates tier)
    { rowId: '4.9', stageName: 'rework_for_quality_round_2', schemaStage: 'quality_rework',
      runCondition: (s) => isAP && s.qualityReviewRound2Verdict === 'changes_required' && !s.terminal,
      isRework: true, handlerKey: 'rework_for_quality_round_2' },
    // 4.10: quality_review_round_3 — final quality attempt
    { rowId: '4.10', stageName: 'quality_review_round_3', schemaStage: 'quality_review',
      runCondition: (s) => isAP && s.qualityReviewRound2Verdict === 'changes_required' && !s.terminal,
      isRework: false, handlerKey: 'quality_review_round_3' },
    // 4.10.x: settle_quality_chain — mirrors quality_review_round_1's gate so we
    // only settle when at least one quality round was supposed to fire.
    // runOnTerminal: same rationale as settle_spec_chain.
    { rowId: '4.10.x', stageName: 'settle_quality_chain',
      runCondition: (s) => (isAP || isRO)
        && (s.reviewPolicy === 'full' || s.reviewPolicy === 'quality_only')
        && (isRO || s.reviewPolicy !== 'full' || s.specChainPassed === true),
      isRework: false, handlerKey: 'settle_quality_chain', runOnTerminal: true },

    // 4.11: review_diff — fires when reviewPolicy in {full, diff_only} AND, for 'full', prior chains passed
    { rowId: '4.11', stageName: 'review_diff', schemaStage: 'diff_review',
      runCondition: (s) => isAP
        && (s.reviewPolicy === 'full' || s.reviewPolicy === 'diff_only')
        && (s.reviewPolicy !== 'full' || (s.specChainPassed === true && s.qualityChainPassed === true))
        && !s.terminal,
      isRework: false, handlerKey: 'review_diff' },

    // Stage 5 — finalize (rows 5.1–5.5)
    // 5.1: run_verify_command — fires for artifact-producing tools only when
    // reviews actually ran (reviewPolicy !== 'none'). The verify route's own
    // verify_work IS the verification, so /verify itself skips this row.
    { rowId: '5.1', stageName: 'run_verify_command', schemaStage: 'verifying',
      runCondition: (s) => s.toolCategory === 'artifact_producing'
        && s.route !== 'verify'
        && s.reviewPolicy !== 'none'
        && !s.terminal,
      isRework: false, handlerKey: 'run_verify_command' },
    // 5.2: git_commit — fires when autoCommit + filesChanged + !readOnlyTask AND
    // reviews actually ran (reviewPolicy !== 'none').
    { rowId: '5.2', stageName: 'git_commit', schemaStage: 'committing',
      runCondition: (s) => s.autoCommit === true
        && Array.isArray(s.filesChanged)
        && s.filesChanged.length > 0
        && !s.readOnlyTask
        && s.reviewPolicy !== 'none'
        && !s.terminal,
      isRework: false, handlerKey: 'git_commit' },
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
