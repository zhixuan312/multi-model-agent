import type { StageHandler } from '../lifecycle-driver.js';
import type { LifecycleState } from '../stage-plan-types.js';
import type { RunResult } from '../../types.js';
import { parseStructuredReport } from '../../reporting/structured-report.js';
import { sumStageCosts } from '../shared-compute.js';
import { gitCommitHandler } from './git-commit-handler.js';
// Pipeline-redesign (4.3.0+) review-and-fix + annotate handlers replace the
// old 11-stage spec/quality/diff/verify chain. See pipeline-redesign spec
// §3.1 / §3.2.
import { specReviewAndFixHandler } from './spec-review-and-fix-handler.js';
import { qualityReviewAndFixHandler } from './quality-review-and-fix-handler.js';
import { annotateCompletionHandler } from './annotate-completion-handler.js';
import { prepareExecutionContextHandler } from './prepare-execution-context-handler.js';
import { registerToBlockStoreHandler } from './register-context-block-handlers.js';
import {
  registerTerminalBlockHandler,
  emitTaskTerminalHandler,
  persistToBatchRegistryHandler,
  recordTaskCompletedHandler,
  flushTelemetryHandler,
} from './terminal-handlers.js';
import { crossCheckFilesWritten } from './files-written-cross-check.js';

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

      // A11.2 — surface canonical per-task cost on the public envelope as
      // `actualCostUSD`, computed from stageStats[*].costUSD across entered
      // stages. Mirrors the batch-level `costSummary.totalActualCostUSD`
      // logic so per-task and batch-level cost views are consistent. The
      // existing `cost: { costUSD, costDeltaVsMainUSD }` field is preserved
      // for back-compat; existing callers continue to work, new callers
      // read `actualCostUSD` directly.
      if (enriched.actualCostUSD === undefined) {
        const stageStats = (last.stageStats ?? undefined) as Record<string, { entered?: boolean; costUSD?: number | null } | undefined> | undefined;
        enriched.actualCostUSD = sumStageCosts(stageStats);
      }

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

      // A4b §2b — terminal cross-check + writes_unverifiable downgrade.
      // Subordinate to chain-fail: when the spec/quality chain already
      // rejected, that rejection IS the user-visible verdict; we don't
      // double-stamp with writes_unverifiable. The downgrade only fires
      // when:
      //   - chain did NOT fail (no review_spec_rejected_terminal etc.)
      //   - worker still said `done` AND had write capability AND
      //     produced zero verifiable artifacts
      // i.e. "worker claimed completion but no disk evidence" without a
      // chain rejection masking it.
      //
      // Read-only routes (audit/review/debug/verify/investigate/research/
      // explore) are EXPLICITLY exempt because their intake has
      // toolsMode='full' even though the read-only contract is enforced
      // at prompt + tool selection time. They legitimately don't write.
      const cwd = (typeof state.cwd === 'string' && state.cwd.length > 0)
        ? state.cwd
        : (typeof ctx?.cwd === 'string' ? ctx.cwd : undefined);
      const tr = (typeof last.terminationReason === 'object' && last.terminationReason !== null)
        ? last.terminationReason
        : undefined;
      const workerSelfAssessment = tr && 'workerSelfAssessment' in tr
        ? (tr as { workerSelfAssessment?: 'done' | 'in_progress' | 'no_op' | null }).workerSelfAssessment
        : null;
      // 4.3.0 pipeline redesign: no more chain-failure state. The
      // writes_unverifiable downgrade now triggers when:
      //   - reviewPolicy is not 'none' AND
      //   - annotator marked the work below threshold (commitGatePercent < threshold)
      // Below-threshold work shouldn't be double-stamped with writes_unverifiable.
      const belowThreshold = (state.commitGatePercent ?? 100) < (state.completionThreshold ?? 80);
      const chainAlreadyFailed = belowThreshold;
      const readOnlyRoutes = new Set(['audit', 'review', 'debug', 'verify', 'investigate', 'research', 'explore']);
      const route = typeof state.route === 'string' ? state.route : '';
      const isReadOnlyRoute = readOnlyRoutes.has(route);
      if (!chainAlreadyFailed && !isReadOnlyRoute && cwd && Array.isArray(enriched.filesWritten)) {
        // Narrow ToolMode to the subset crossCheckFilesWritten accepts.
        // `'no-shell'` was added to ToolMode but isn't part of A4b's contract;
        // for cross-check purposes treat it as `'full'` (worker has write
        // capability via the non-shell tools).
        const ctxToolMode = ctx?.implementerToolMode;
        const toolsMode: 'full' | 'readonly' | 'none' | undefined =
          ctxToolMode === 'no-shell' ? 'full' : ctxToolMode;
        const xc = crossCheckFilesWritten({
          cwd,
          filesWritten: enriched.filesWritten,
          workerSelfAssessment: workerSelfAssessment ?? null,
          toolsMode,
          autoCommit: state.autoCommit,
        });
        enriched.filesWritten = xc.filesWritten;
        // Only surface filesWrittenMissing when non-empty — keeps the
        // common case unchanged on the public envelope.
        if (xc.filesWrittenMissing.length > 0) {
          (enriched as { filesWrittenMissing?: string[] }).filesWrittenMissing = xc.filesWrittenMissing;
        }
        if (xc.workerStatus === 'error') {
          enriched.workerStatus = 'failed';
          enriched.errorCode = xc.errorCode;
          enriched.error = xc.errorMessage;
        }
      }

      // Pipeline-redesign envelope assembly (4.3.0+, spec §3.5).
      // Surface annotator output + reviewer notes + verify result as
      // additive envelope fields. Status derivation:
      //   - last.status === 'error' (Stage 1 worker crashed) → 'error'
      //   - commits.length > 0 → 'ok' (commit landed → success)
      //   - commitGatePercent ≥ threshold but no commit (rare; autoCommit=false) → 'ok'
      //   - else → 'incomplete' with errorCode 'completion_below_threshold'
      if (state.completionAnnotation !== undefined) {
        (enriched as { completionAnnotation?: unknown }).completionAnnotation = state.completionAnnotation;
      }
      if (state.commitGatePercent !== undefined) {
        (enriched as { commitGatePercent?: number }).commitGatePercent = state.commitGatePercent;
      }
      if (state.specReviewerNotes !== undefined) {
        (enriched as { specReviewerNotes?: string }).specReviewerNotes = state.specReviewerNotes;
      }
      if (state.qualityReviewerNotes !== undefined) {
        (enriched as { qualityReviewerNotes?: string }).qualityReviewerNotes = state.qualityReviewerNotes;
      }
      if (state.verifyResult !== undefined) {
        (enriched as { verifyResult?: unknown }).verifyResult = state.verifyResult;
      }

      const commitsExist = Array.isArray(state.commits) && state.commits.length > 0;
      const gatePercent = state.commitGatePercent ?? 0;
      const threshold = state.completionThreshold ?? 80;

      if (last.status === 'error') {
        enriched.status = 'error';
      } else if (commitsExist) {
        enriched.status = 'ok';
      } else if (gatePercent >= threshold) {
        enriched.status = 'ok';  // gate passed but commit didn't fire (e.g., autoCommit=false)
      } else if ((last.filesWritten as string[] | undefined)?.length) {
        // Files written but below threshold → incomplete; surface annotation
        enriched.status = 'incomplete';
        enriched.errorCode = 'completion_below_threshold';
        const priorTr = (typeof enriched.terminationReason === 'object' && enriched.terminationReason !== null)
          ? enriched.terminationReason
          : undefined;
        enriched.terminationReason = {
          cause: 'incomplete',
          turnsUsed: priorTr?.turnsUsed ?? last.turns ?? 0,
          hasFileArtifacts: priorTr?.hasFileArtifacts ?? (Array.isArray(last.filesWritten) && last.filesWritten.length > 0),
          usedShell: priorTr?.usedShell ?? false,
          workerSelfAssessment: 'done_with_concerns',
          wasPromoted: false,
        };
      }
      // else: no files, no commit → leave status as worker reported (ok/incomplete/error)

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

    spec_review_and_fix: specReviewAndFixHandler,
    quality_review_and_fix: qualityReviewAndFixHandler,
    annotate_completion: annotateCompletionHandler,

    register_to_block_store: registerToBlockStoreHandler,
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
