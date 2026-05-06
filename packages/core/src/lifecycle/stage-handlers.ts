import type { StageHandler } from './lifecycle-driver.js';
import type { LifecycleState } from './stage-plan-types.js';
import { runVerifyCommandHandler } from './handlers/run-verify-command-handler.js';
import { gitCommitHandler } from './handlers/git-commit-handler.js';
import {
  specReviewRound1Handler,
  specReviewRound2Handler,
  specReviewRound3Handler,
  specReworkRound1Handler,
  specReworkRound2Handler,
  settleSpecChainHandler,
} from './handlers/spec-chain-handlers.js';
import {
  qualityReviewRound1Handler,
  qualityReviewRound2Handler,
  qualityReviewRound3Handler,
  qualityReworkRound1Handler,
  qualityReworkRound2Handler,
  settleQualityChainHandler,
} from './handlers/quality-chain-handlers.js';
import { reviewDiffHandler } from './handlers/review-diff-handler.js';
import { prepareExecutionContextHandler } from './handlers/prepare-execution-context-handler.js';

/**
 * Spec C10 stage handlers. The StagePlan declares 32 rows; this module
 * registers a handler for every key buildStagePlan produces.
 *
 * Most stages are no-ops at the dispatcher level today: their work happens
 * either upstream (HTTP middleware does loopback/cwd/auth as 1.x and 2.x
 * reads parsed body) or inside the per-route executor (reviewed-lifecycle.ts
 * runs impl + reviews + verify + commit as one unit, covering rows 3.x,
 * 4.x, and 5.1–5.2).
 *
 * The substantive handlers in this file are:
 *   - run_initial_impl: invokes the executor registered for state.route,
 *     stores the executor's result in state.executorResult
 *   - compose_response: lifts state.executorResult into state.responseEnvelope
 *
 * Decomposing the executor monolith into per-row handlers (so spec_review_*,
 * quality_review_*, run_verify_command, git_commit each become real stages)
 * is task #45's continuation work.
 */

export type RouteExecutor = (
  rawRequest: unknown,
  state: LifecycleState,
) => Promise<unknown>;

export interface DispatcherDeps {
  executors: Record<string, RouteExecutor>;
}

const noop: StageHandler = () => { /* placeholder for future decomposition */ };

export function buildStageHandlers(deps: DispatcherDeps): Record<string, StageHandler> {
  const runInitialImpl: StageHandler = async (state) => {
    const route = state.route;
    if (typeof route !== 'string') {
      throw new Error('run_initial_impl: state.route must be a string');
    }
    // Prefer the per-call executor injected via DispatchInput; fall back to
    // a route-keyed registry for callers (tests) that pre-register executors.
    const executor =
      (state.executor as RouteExecutor | undefined) ?? deps.executors[route];
    if (!executor) {
      throw new Error(`run_initial_impl: no executor registered for route '${route}'`);
    }
    const result = await executor(state.request, state);
    state.executorResult = result;
  };

  const composeResponse: StageHandler = (state) => {
    state.responseEnvelope = state.executorResult;
  };

  return {
    // Stage 1 — Ingress (HTTP middleware did the work; rows are structural)
    accept_http_request: noop,
    verify_loopback: noop,
    validate_workspace: noop,
    load_project_state: noop,

    // Stage 2 — Intake (HTTP handler parsed + validated; runtime intake
    // pipeline runs inside delegate/retry executors)
    parse_brief: noop,
    verify_referenced_blocks: noop,
    apply_defaults: noop,
    mark_intake_complete: noop,
    // prepare_execution_context (row 2.5) wired as structural — surfaces
    // first TaskSpec from rawRequest if state.task is empty, otherwise
    // honors state.task / state.executionContext supplied via
    // DispatchInput.context. Callers wanting the new dispatcher path
    // active end-to-end populate context with { executionContext, task }.
    prepare_execution_context: prepareExecutionContextHandler,

    // Stage 3 — Initial run (substantive)
    run_initial_impl: runInitialImpl,

    // 3.5 — placeholder; the early-exit logic gates on `runCondition` (zero
    // files written + reviewPolicy != quality_only + artifact_producing).
    // When the gate fires, this handler short-circuits the lifecycle by
    // setting terminal=true. Actual implementation lands with Step 5
    // (run_initial_impl decomposition); for now it's a no-op so the driver
    // doesn't throw on missing-key.
    check_files_written: noop,

    // Stage 4 — Spec + quality + diff review chains
    //
    // Spec chain (rows 4.1–4.6) wired to real handlers in spec-chain-handlers.ts.
    // Each handler is idempotent on its verdict slot and defensive-no-ops on
    // missing state.task / state.executionContext / state.lastRunResult so the
    // legacy executor still owns the chain in production until Step 5 lands
    // the per-task data flow.
    spec_review_round_1: specReviewRound1Handler,
    rework_for_spec_round_1: specReworkRound1Handler,
    spec_review_round_2: specReviewRound2Handler,
    rework_for_spec_round_2: specReworkRound2Handler,
    spec_review_round_3: specReviewRound3Handler,
    settle_spec_chain: settleSpecChainHandler,
    // Quality chain (rows 4.7–4.12) wired to real handlers in
    // quality-chain-handlers.ts. Symmetric with spec chain. Annotator path
    // (read-only routes) returns 'annotated' which never triggers rework
    // (the rework gate is `qualityReviewRound1Verdict === 'changes_required'`).
    quality_review_round_1: qualityReviewRound1Handler,
    rework_for_quality_round_1: qualityReworkRound1Handler,
    quality_review_round_2: qualityReviewRound2Handler,
    rework_for_quality_round_2: qualityReworkRound2Handler,
    quality_review_round_3: qualityReviewRound3Handler,
    settle_quality_chain: settleQualityChainHandler,
    // review_diff (row 4.13) wired to real handler in review-diff-handler.ts.
    // Idempotent on state.diffReviewVerdict; defensive no-op on missing
    // verifyResult / executionContext / reviewer provider. Verdict mapping
    // preserves the kind: 'concerns' → envelope 'approved' counter-intuitive
    // path from reviewed-lifecycle.ts:1361.
    review_diff: reviewDiffHandler,

    // Stage 5 — Finalize (verify + commit happen in executor; response
    // composed here, terminal block + telemetry will move out of executor
    // when persistence cutover lands)
    //
    // run_verify_command is wired to the real handler implementation. The
    // handler is idempotent: it skips when state.verifyResult is already set
    // (which is what the legacy executor does today via DelegateOutput.results
    // — until Step 5 plumbs verifyResult through state, the handler defensively
    // no-ops on missing state.task/state.executionContext).
    run_verify_command: runVerifyCommandHandler,
    // git_commit: real handler implementation. Idempotent — skips when
    // state.commits is already populated (legacy executor path) or the
    // data flow slots aren't ready. Full activation lands with Step 5.
    git_commit: gitCommitHandler,
    compose_response: composeResponse,
    register_terminal_block: noop,
    emit_task_terminal: noop,
    persist_to_batch_registry: noop,

    // Stage 6 — Emit + cleanup (timer-driven rows with runCondition=false
    // never fire from per-request iteration)
    flush_telemetry: noop,
    project_idle_cleanup_tick: noop,
    batch_retention_sweep_tick: noop,
  };
}
