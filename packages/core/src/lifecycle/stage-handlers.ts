import type { StageHandler } from './lifecycle-driver.js';
import type { LifecycleState } from './stage-plan-types.js';
import type { RunResult } from '../types.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
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
import {
  registerTerminalBlockHandler,
  emitTaskTerminalHandler,
  persistToBatchRegistryHandler,
  flushTelemetryHandler,
} from './handlers/terminal-handlers.js';

/**
 * Spec C10 stage handlers. The StagePlan declares 32 rows; this module
 * registers a handler for every key buildStagePlan produces.
 *
 * Most stages are no-ops at the dispatcher level today: their work happens
 * either upstream (HTTP middleware handles ingress rows 1.x and parsed-body
 * intake row 2.x) or inside the per-route executor (rows 3.x, 4.x, and
 * 5.1–5.2 — impl + reviews + verify + commit run via the StagePlan + driver
 * decomposed into lifecycle/handlers/).
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
}

const noop: StageHandler = () => { /* placeholder for future decomposition */ };

export function buildStageHandlers(deps: DispatcherDeps): Record<string, StageHandler> {
  const runInitialImpl: StageHandler = async (state) => {
    const route = state.route;
    if (typeof route !== 'string') {
      throw new Error('run_initial_impl: state.route must be a string');
    }

    const executor = state.executor as RouteExecutor | undefined;
    if (!executor) {
      throw new Error(`run_initial_impl: state.executor is not set for route ${route}`);
    }

    const result = await executor(state.request, state);
    state.executorResult = result;
  };

  const composeResponse: StageHandler = (state) => {
    // Legacy path: executor returned the full envelope.
    if (state.executorResult !== undefined) {
      state.responseEnvelope = state.executorResult;
      return;
    }
    // Direct path (#45 Step 7a): assemble envelope from per-handler state.
    // Today the envelope IS the RunResult — the per-route executors
    // (executeDelegate, etc.) wrap N RunResults into route-specific shapes
    // (DelegateOutput, etc.). At the per-task dispatch boundary we emit
    // the raw RunResult; the runTasks layer aggregates.
    if (state.lastRunResult !== undefined) {
      // Enrich the terminal RunResult with per-handler-state slots so
      // consumers reading specReviewStatus / qualityReviewStatus /
      // diffReviewStatus get the chain outcomes from the per-round
      // verdict slots, mapped onto the canonical envelope fields.
      const last = state.lastRunResult as RunResult;
      const enriched: RunResult = { ...last };

      // Spec chain → specReviewStatus. Cascade:
      //   - 'approved' wins (chain passed)
      //   - 'error' for hard fail
      //   - 'changes_required' for soft fail
      //   - 'not_applicable' when chain didn't apply (no files, wrong policy)
      const specVerdicts = [state.specReviewRound1Verdict, state.specReviewRound2Verdict, state.specReviewRound3Verdict];
      if (specVerdicts.some((v) => v === 'approved')) {
        enriched.specReviewStatus = 'approved';
      } else if (specVerdicts.some((v) => v === 'error')) {
        enriched.specReviewStatus = 'error';
      } else if (specVerdicts.some((v) => v === 'changes_required')) {
        enriched.specReviewStatus = 'changes_required';
      } else {
        // No spec verdict fired: chain didn't apply (no files written or
        // reviewPolicy excludes spec).
        enriched.specReviewStatus = 'not_applicable';
      }

      // Quality chain → qualityReviewStatus. Mirrors spec but includes
      // the 'annotated' verdict (read-only routes).
      const qualVerdicts = [state.qualityReviewRound1Verdict, state.qualityReviewRound2Verdict, state.qualityReviewRound3Verdict];
      if (qualVerdicts.some((v) => v === 'annotated')) {
        enriched.qualityReviewStatus = 'annotated';
      } else if (qualVerdicts.some((v) => v === 'approved')) {
        enriched.qualityReviewStatus = 'approved';
      } else if (qualVerdicts.some((v) => v === 'error')) {
        enriched.qualityReviewStatus = 'error';
      } else if (qualVerdicts.some((v) => v === 'changes_required')) {
        enriched.qualityReviewStatus = 'changes_required';
      } else {
        // No quality verdict fired (skipped or didn't apply).
        enriched.qualityReviewStatus = 'not_applicable';
      }

      // Diff review → diffReviewStatus.
      if (state.diffReviewVerdict !== undefined) {
        enriched.diffReviewStatus = state.diffReviewVerdict;
      } else if (state.reviewPolicy === 'full' || state.reviewPolicy === 'diff_only') {
        enriched.diffReviewStatus = 'skipped';
      } else {
        enriched.diffReviewStatus = 'not_applicable';
      }

      // Verify outcome already lives on state.lastRunResult.verification
      // when run_verify_command fired; preserve as-is. Same for commits.
      if (state.verifyResult !== undefined && enriched.verification === undefined) {
        enriched.verification = state.verifyResult as RunResult['verification'];
      }
      if (Array.isArray(state.commits) && enriched.commits === undefined) {
        enriched.commits = state.commits as RunResult['commits'];
      } else if (enriched.commits === undefined) {
        // Terminal-RunResult invariant: commits is always an array
        // (possibly empty) on the final envelope.
        enriched.commits = [];
      }
      if (typeof state.commitError === 'string' && enriched.commitError === undefined) {
        enriched.commitError = state.commitError;
      }

      // agents block: synthesize from ExecutionContext + chain verdicts.
      const ctx = state.executionContext;
      if (ctx && enriched.agents === undefined) {
        const specReviewerTier =
          enriched.specReviewStatus === 'approved' || enriched.specReviewStatus === 'changes_required'
            ? (ctx.assignedTier === 'standard' ? 'complex' : 'standard')
            : (enriched.specReviewStatus === 'not_applicable' ? 'not_applicable' : 'skipped');
        const qualityReviewerTier =
          enriched.qualityReviewStatus === 'approved'
            || enriched.qualityReviewStatus === 'changes_required'
            || enriched.qualityReviewStatus === 'annotated'
            ? (ctx.assignedTier === 'standard' ? 'complex' : 'standard')
            : (enriched.qualityReviewStatus === 'not_applicable' ? 'not_applicable' : 'skipped');
        enriched.agents = {
          implementer: ctx.assignedTier,
          implementerToolMode: ctx.implementerToolMode ?? 'full',
          specReviewer: specReviewerTier,
          qualityReviewer: qualityReviewerTier,
        };
      }

      // fileArtifactsMissing — false unless verification flagged missing
      // artifacts (terminal-envelope invariant).
      if (enriched.fileArtifactsMissing === undefined) {
        enriched.fileArtifactsMissing = false;
      }

      // specReviewReason / qualityReviewReason: stub based on the
      // review-status outcome — these strings explain why a review was
      // skipped/not_applicable.
      if (enriched.specReviewReason === undefined) {
        enriched.specReviewReason = enriched.specReviewStatus === 'not_applicable'
          ? 'task produced no file artifacts to review'
          : '';
      }
      if (enriched.qualityReviewReason === undefined) {
        enriched.qualityReviewReason = enriched.qualityReviewStatus === 'not_applicable'
          ? 'task produced no file artifacts to review'
          : '';
      }

      // implementationReport / structuredReport: parse result.output and
      // attach to the terminal RunResult so consumers (orchestrator
      // contract tests, fallback-report extraction) see the parsed
      // report. Always populate both slots — they may carry independent
      // values when the runner pre-populates one of them.
      const fallbackReport = (last.output
        ? parseStructuredReport(last.output)
        : { summary: '', filesChanged: [], validationsRun: [], deviationsFromBrief: [], unresolved: [], extraSections: {} }
      ) as RunResult['implementationReport'];
      if (enriched.implementationReport === undefined) {
        enriched.implementationReport = fallbackReport;
      }
      if (enriched.structuredReport === undefined) {
        enriched.structuredReport = fallbackReport;
      }
      if (enriched.workerStatus === undefined) {
        const summary = (fallbackReport?.summary ?? '').toLowerCase();
        if (last.status === 'error') {
          enriched.workerStatus = 'failed';
        } else if (summary.includes('changes_required') || summary.includes('blocked')) {
          enriched.workerStatus = 'blocked';
        } else if (summary.length > 0 || last.status === 'ok') {
          enriched.workerStatus = 'done';
        } else {
          enriched.workerStatus = 'failed';
        }
      }

      // Step 7i: models block. Legacy executor populated this from the
      // resolved provider config. Synthesize from ctx.implementerProvider
      // and the reviewer-tier providers.
      if (ctx && enriched.models === undefined) {
        const implModel = (ctx.implementerProvider?.config as { model?: string } | undefined)?.model ?? '';
        const otherTier = ctx.assignedTier === 'standard' ? 'complex' : 'standard';
        const otherProvider = ctx.providers[otherTier];
        const otherModel = (otherProvider?.config as { model?: string } | undefined)?.model ?? null;
        enriched.models = {
          implementer: implModel,
          specReviewer: enriched.specReviewStatus === 'approved' || enriched.specReviewStatus === 'changes_required' ? otherModel : null,
          qualityReviewer: enriched.qualityReviewStatus === 'approved' || enriched.qualityReviewStatus === 'changes_required' || enriched.qualityReviewStatus === 'annotated' ? otherModel : null,
        };
      }

      state.responseEnvelope = enriched;
      return;
    }
    state.responseEnvelope = undefined;
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
    // missing state.task / state.executionContext / state.lastRunResult so
    // re-runs and retry paths don't re-fire reviewer turns.
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
    // verifyResult / executionContext / reviewer provider. Note: 'concerns'
    // verdict maps to envelope 'approved' (the diff reviewer flags
    // non-blocking concerns rather than blocking changes).
    review_diff: reviewDiffHandler,

    // Stage 5 — Finalize.
    //
    // run_verify_command is idempotent: skips when state.verifyResult is
    // already set, defensive-no-ops on missing state.task /
    // state.executionContext.
    run_verify_command: runVerifyCommandHandler,
    // git_commit: idempotent — skips when state.commits is already
    // populated.
    git_commit: gitCommitHandler,
    compose_response: composeResponse,
    // Terminal-stage rows. Each handler is idempotent on its state-slot
    // guard and defensive-no-ops on missing data flow.
    register_terminal_block: registerTerminalBlockHandler,
    emit_task_terminal: emitTaskTerminalHandler,
    persist_to_batch_registry: persistToBatchRegistryHandler,

    // Stage 6 — Emit + cleanup (timer-driven rows with runCondition=false
    // never fire from per-request iteration)
    flush_telemetry: flushTelemetryHandler,
    project_idle_cleanup_tick: noop,
    batch_retention_sweep_tick: noop,
  };
}
