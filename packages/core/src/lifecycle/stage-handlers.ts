import type { StageHandler } from './lifecycle-driver.js';
import type { LifecycleState } from './stage-plan-types.js';
import type { ExecutionContext } from './lifecycle-context.js';
import type { TaskSpec, RunResult, Provider, AgentType } from '../types.js';
import { delegateWithEscalation } from '../escalation/delegate-with-escalation.js';
import { pickEscalation } from '../escalation/policy.js';
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

    // Direct path (#45 Step 7a): when state.task + state.executionContext are
    // populated and no executor closure is supplied, run delegateWithEscalation
    // directly. The result lands in state.lastRunResult so downstream handlers
    // (spec/quality/diff chains, verify, commit, terminal) can cascade.
    const executor =
      (state.executor as RouteExecutor | undefined) ?? deps.executors[route];
    if (!executor) {
      const task = state.task as TaskSpec | undefined;
      const ctx = state.executionContext as ExecutionContext | undefined;
      if (!task || !ctx) {
        throw new Error(
          `run_initial_impl: no executor registered for route '${route}' and ` +
          `no direct-path inputs (state.task / state.executionContext)`,
        );
      }
      const baseTier: AgentType = ctx.assignedTier;
      const decision = pickEscalation({ loop: 'spec', attemptIndex: 0, baseTier });
      const provider = ctx.providers[decision.impl] as Provider | undefined;
      if (!provider) {
        state.lastRunResult = {
          output: '',
          status: 'error',
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 0,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: true,
          escalationLog: [],
          parsedFindings: null,
          error: `no provider configured for tier '${decision.impl}'`,
          errorCode: 'all_tiers_unavailable',
          workerStatus: 'failed',
        } as unknown as RunResult;
        state.terminal = true;
        return;
      }
      try {
        const result = await delegateWithEscalation(
          {
            prompt: task.prompt,
            cwd: ctx.cwd,
            agentType: decision.impl,
            briefQualityPolicy: 'off',
            timeoutMs: ctx.timing.timeoutMs,
            ...(task.tools !== undefined && { tools: task.tools }),
          },
          [provider],
          {
            explicitlyPinned: false,
            taskDeadlineMs: ctx.timing.deadlineMs,
            abortSignal: ctx.stall.controller.signal,
            assignedTier: decision.impl,
          },
        );
        state.lastRunResult = result as unknown as RunResult;
        if (result.status !== 'ok') {
          state.terminal = true;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.lastRunResult = {
          output: '',
          status: 'error',
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 0,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: true,
          escalationLog: [],
          parsedFindings: null,
          error: message,
          errorCode: 'executor_error',
          workerStatus: 'failed',
        } as unknown as RunResult;
        state.terminal = true;
      }
      return;
    }

    // Legacy path: per-call executor closure does the full reviewed-lifecycle.
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
      // Step 7d: enrich the terminal RunResult with per-handler-state slots
      // so consumers reading specReviewStatus / qualityReviewStatus /
      // diffReviewStatus get the chain outcomes the legacy executor
      // populated. Maps the per-round verdict slots into the legacy
      // envelope fields.
      const last = state.lastRunResult as RunResult;
      const enriched: RunResult = { ...last };

      // Spec chain → specReviewStatus. Pick the most-recent verdict that
      // determined the chain outcome: any 'approved' wins (chain passed),
      // else the last 'changes_required' (chain failed at round 3),
      // else 'error', else 'skipped' / 'not_applicable'.
      const specVerdicts = [state.specReviewRound1Verdict, state.specReviewRound2Verdict, state.specReviewRound3Verdict];
      if (specVerdicts.some((v) => v === 'approved')) {
        enriched.specReviewStatus = 'approved';
      } else if (specVerdicts.some((v) => v === 'error')) {
        enriched.specReviewStatus = 'error';
      } else if (specVerdicts.some((v) => v === 'changes_required')) {
        enriched.specReviewStatus = 'changes_required';
      } else if (state.reviewPolicy === 'full') {
        enriched.specReviewStatus = 'skipped';
      } else {
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
      } else if (qualVerdicts.some((v) => v === 'skipped')) {
        enriched.qualityReviewStatus = 'skipped';
      } else if (state.reviewPolicy === 'full' || state.reviewPolicy === 'quality_only') {
        enriched.qualityReviewStatus = 'skipped';
      } else {
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
        // Match legacy executor's terminal-RunResult invariant: commits is
        // always an array (possibly empty) on the final envelope.
        enriched.commits = [];
      }
      if (typeof state.commitError === 'string' && enriched.commitError === undefined) {
        enriched.commitError = state.commitError;
      }

      // Step 7f: agents block. Legacy executor populated this from per-tier
      // bookkeeping. Synthesize from ExecutionContext + chain verdicts.
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

      // Step 7f: fileArtifactsMissing — false unless verification flagged
      // missing artifacts (matches legacy invariant for the terminal envelope).
      if (enriched.fileArtifactsMissing === undefined) {
        enriched.fileArtifactsMissing = false;
      }

      // Step 7i: specReviewReason / qualityReviewReason. Stub based on the
      // review-status outcome — matches legacy executor's invariant that
      // these strings explain why a review was skipped/not_applicable.
      if (enriched.specReviewReason === undefined) {
        enriched.specReviewReason = enriched.specReviewStatus === 'not_applicable'
          ? 'task produced no file artifacts to review'
          : enriched.specReviewStatus === 'skipped'
            ? 'spec review skipped (reviewPolicy or all reviewer tiers unavailable)'
            : '';
      }
      if (enriched.qualityReviewReason === undefined) {
        enriched.qualityReviewReason = enriched.qualityReviewStatus === 'not_applicable'
          ? 'task produced no file artifacts to review'
          : enriched.qualityReviewStatus === 'skipped'
            ? 'quality review skipped (no files written or all reviewer tiers unavailable)'
            : '';
      }

      // Step 7i: implementationReport / structuredReport from result.output.
      // Legacy executor parsed these and attached them to the terminal
      // RunResult. Mirror that behavior so consumers that read these fields
      // (orchestrator contract tests, fallback-report extraction, etc) get
      // the parsed report.
      if (last.output && enriched.implementationReport === undefined) {
        const parsed = parseStructuredReport(last.output);
        enriched.implementationReport = parsed;
        if (enriched.structuredReport === undefined) {
          enriched.structuredReport = parsed;
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
    // Terminal-stage rows wired to real handlers in terminal-handlers.ts.
    // Each handler is idempotent on its state-slot guard and defensive-no-ops
    // on missing data flow. The legacy executor still owns the terminal stage
    // in production until Step 5's full cutover wires per-task data flow.
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
