import type { StageHandler } from '../lifecycle-driver.js';
import type { LifecycleState } from '../stage-plan-types.js';
import type { RunResult } from '../../types.js';
import { parseStructuredReport } from '../../reporting/structured-report.js';
import { runVerifyCommandHandler } from './run-verify-command-handler.js';
import { gitCommitHandler } from './git-commit-handler.js';
import {
  specReviewRound1Handler,
  specReviewRound2Handler,
  specReviewRound3Handler,
  specReworkRound1Handler,
  specReworkRound2Handler,
  settleSpecChainHandler,
} from './spec-chain-handlers.js';
import {
  qualityReviewRound1Handler,
  qualityReviewRound2Handler,
  qualityReviewRound3Handler,
  qualityReworkRound1Handler,
  qualityReworkRound2Handler,
  settleQualityChainHandler,
} from './quality-chain-handlers.js';
import { reviewDiffHandler } from './review-diff-handler.js';
import { prepareExecutionContextHandler } from './prepare-execution-context-handler.js';
import { registerToBlockStoreHandler } from './register-context-block-handlers.js';
import {
  registerTerminalBlockHandler,
  emitTaskTerminalHandler,
  persistToBatchRegistryHandler,
  recordTaskCompletedHandler,
  flushTelemetryHandler,
} from './terminal-handlers.js';

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
    if (state.route === 'register-context-block' && state.blockRegistration) {
      state.responseEnvelope = { id: state.blockRegistration.id };
      return;
    }
    if (state.executorResult !== undefined) {
      state.responseEnvelope = state.executorResult;
      return;
    }
    if (state.lastRunResult !== undefined) {
      const last = state.lastRunResult as RunResult;
      const enriched: RunResult = { ...last };

      const specVerdicts = [state.specReviewRound1Verdict, state.specReviewRound2Verdict, state.specReviewRound3Verdict];
      if (specVerdicts.some((v) => v === 'approved')) {
        enriched.specReviewStatus = 'approved';
      } else if (specVerdicts.some((v) => v === 'error')) {
        enriched.specReviewStatus = 'error';
      } else if (specVerdicts.some((v) => v === 'changes_required')) {
        enriched.specReviewStatus = 'changes_required';
      } else {
        enriched.specReviewStatus = 'not_applicable';
      }

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
        enriched.qualityReviewStatus = 'not_applicable';
      }

      if (state.diffReviewVerdict !== undefined) {
        enriched.diffReviewStatus = state.diffReviewVerdict;
      } else if (state.reviewPolicy === 'full' || state.reviewPolicy === 'diff_only') {
        enriched.diffReviewStatus = 'skipped';
      } else {
        enriched.diffReviewStatus = 'not_applicable';
      }

      if (state.verifyResult !== undefined && enriched.verification === undefined) {
        enriched.verification = state.verifyResult as RunResult['verification'];
      }
      if (Array.isArray(state.commits) && enriched.commits === undefined) {
        enriched.commits = state.commits as RunResult['commits'];
      } else if (enriched.commits === undefined) {
        enriched.commits = [];
      }
      if (typeof state.commitError === 'string' && enriched.commitError === undefined) {
        enriched.commitError = state.commitError;
      }

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

      if (enriched.fileArtifactsMissing === undefined) {
        enriched.fileArtifactsMissing = false;
      }

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

      // Chain-failure status override: the implementer's lastRunResult.status
      // is 'ok' when its turn finished cleanly, but if the spec/quality chain
      // (or its rework) ultimately rejected the work, the wire envelope must
      // reflect that — otherwise task_completed reports status=ok despite
      // spec_chain_passed=false. Mutate state.lastRunResult so emit_task_terminal
      // (which reads lastRunResult.status directly) picks up the corrected
      // shape.
      const chainFailed =
        state.specReworkFailed === true ||
        state.qualityReworkFailed === true ||
        state.specChainPassed === false ||
        state.qualityChainPassed === false;
      if (chainFailed) {
        enriched.status = 'incomplete';
        enriched.workerStatus = 'review_loop_capped';
        if (state.specReworkFailed === true || state.qualityReworkFailed === true) {
          enriched.errorCode = 'lifecycle_review_loop_capped';
        } else if (state.specChainPassed === false) {
          enriched.errorCode = 'review_spec_rejected_terminal';
        } else {
          enriched.errorCode = 'review_quality_findings_unresolved';
        }
        // The wire event derives terminalStatus + workerStatus from
        // RunResult.terminationReason. The implementer's RunResult has
        // cause='finished' + workerSelfAssessment='done', which produces
        // terminalStatus='ok' regardless of our status/errorCode overrides
        // — yielding the R1 invariant violation (terminalStatus=ok with
        // non-null errorCode). Override terminationReason so the chain-fail
        // path produces a clean terminalStatus='incomplete' on the wire.
        const priorTr = (typeof enriched.terminationReason === 'object' && enriched.terminationReason !== null)
          ? enriched.terminationReason
          : undefined;
        enriched.terminationReason = {
          cause: 'incomplete',
          turnsUsed: priorTr?.turnsUsed ?? last.turns ?? 0,
          hasFileArtifacts: priorTr?.hasFileArtifacts ?? (Array.isArray(last.filesWritten) && last.filesWritten.length > 0),
          usedShell: priorTr?.usedShell ?? false,
          workerSelfAssessment: 'review_loop_capped',
          wasPromoted: false,
        };
      }

      state.responseEnvelope = enriched;
      // emit_task_terminal reads state.lastRunResult, not state.responseEnvelope,
      // so propagate the chain-failure overrides back to the underlying slot
      // so the wire `task_completed` event carries them too.
      state.lastRunResult = enriched;
      return;
    }
    state.responseEnvelope = undefined;
  };

  return {
    accept_http_request: noop,
    verify_loopback: noop,
    validate_workspace: noop,
    load_project_state: noop,

    parse_brief: noop,
    verify_referenced_blocks: noop,
    apply_defaults: noop,
    mark_intake_complete: noop,
    prepare_execution_context: prepareExecutionContextHandler,

    run_initial_impl: runInitialImpl,

    check_files_written: noop,

    spec_review_round_1: specReviewRound1Handler,
    rework_for_spec_round_1: specReworkRound1Handler,
    spec_review_round_2: specReviewRound2Handler,
    rework_for_spec_round_2: specReworkRound2Handler,
    spec_review_round_3: specReviewRound3Handler,
    settle_spec_chain: settleSpecChainHandler,
    quality_review_round_1: qualityReviewRound1Handler,
    rework_for_quality_round_1: qualityReworkRound1Handler,
    quality_review_round_2: qualityReviewRound2Handler,
    rework_for_quality_round_2: qualityReworkRound2Handler,
    quality_review_round_3: qualityReviewRound3Handler,
    settle_quality_chain: settleQualityChainHandler,
    review_diff: reviewDiffHandler,

    register_to_block_store: registerToBlockStoreHandler,
    run_verify_command: runVerifyCommandHandler,
    git_commit: gitCommitHandler,
    compose_response: composeResponse,
    register_terminal_block: registerTerminalBlockHandler,
    emit_task_terminal: emitTaskTerminalHandler,
    persist_to_batch_registry: persistToBatchRegistryHandler,
    record_task_completed: recordTaskCompletedHandler,

    flush_telemetry: flushTelemetryHandler,
    project_idle_cleanup_tick: noop,
    batch_retention_sweep_tick: noop,
  };
}
