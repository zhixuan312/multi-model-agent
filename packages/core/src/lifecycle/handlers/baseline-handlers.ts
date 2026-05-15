import type { StageHandler } from '../lifecycle-driver.js';
import type { LifecycleState } from '../stage-plan-types.js';
import type { RunResult } from '../../types.js';
import type { ComposePayload, StageGate, StageStopReason, WorkerSelfAssessment } from '../stage-io.js';
import { parseStructuredReport } from '../../reporting/structured-report.js';
import { sumStageCosts } from '../shared-compute.js';
import { gitCommitHandler } from './git-commit-handler.js';
// Pipeline-redesign (4.3.0+) review-and-fix + annotate handlers replace the
// old 11-stage spec/quality/diff/verify chain. See pipeline-redesign spec
// §3.1 / §3.2.
import { reviewHandler } from './review-handler.js';
import { reworkHandler } from './rework-handler.js';
import { annotator } from './annotator.js';
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

      // A11.2 — surface canonical per-task cost on the public envelope as
      // `actualCostUSD`, computed from stageStats[*].costUSD across entered
      // stages. Mirrors the batch-level `costSummary.totalActualCostUSD`
      // logic so per-task and batch-level cost views are consistent. The
      // existing `cost: { costUSD, costDeltaVsMainUSD }` field is preserved
      // for back-compat; existing callers continue to work, new callers
      // read `actualCostUSD` directly.
      if (enriched.actualCostUSD === undefined) {
        const stageStats = (last.stageStats ?? undefined) as Record<string, { entered?: boolean; costUSD?: number | null } | undefined> | undefined;
        enriched.actualCostUSD = sumStageCosts(stageStats) ?? 0;
      }
      const e = enriched as unknown as Record<string, unknown>;
      if (state.specReviewError !== undefined) {
        e.specReviewStatus = 'error';
      } else if (state.specReviewVerdict !== undefined) {
        e.specReviewStatus = state.specReviewVerdict;
      } else {
        e.specReviewStatus = 'not_applicable';
      }

      if (state.qualityReviewError !== undefined) {
        e.qualityReviewStatus = 'error';
      } else if (state.qualityReviewVerdict !== undefined) {
        e.qualityReviewStatus = state.qualityReviewVerdict;
      } else {
        e.qualityReviewStatus = 'not_applicable';
      }

      if (state.diffReviewVerdict !== undefined) {
        e.diffReviewStatus = state.diffReviewVerdict;
      } else if (state.reviewPolicy === 'full' || state.reviewPolicy === 'diff_only') {
        e.diffReviewStatus = 'skipped';
      } else {
        e.diffReviewStatus = 'not_applicable';
      }

      if (state.verifyResult !== undefined && e.verification === undefined) {
        e.verification = state.verifyResult;
      }
      if (Array.isArray(state.commits) && e.commits === undefined) {
        e.commits = state.commits;
      } else if (e.commits === undefined) {
        e.commits = [];
      }
      if (typeof state.commitError === 'string' && e.commitError === undefined) {
        e.commitError = state.commitError;
      }

      const ctx = state.executionContext;
      if (ctx && e.agents === undefined) {
        const specReviewerTier =
          e.specReviewStatus === 'approved' || e.specReviewStatus === 'changes_required'
            ? (ctx.assignedTier === 'standard' ? 'complex' : 'standard')
            : (e.specReviewStatus === 'not_applicable' ? 'not_applicable' : 'skipped');
        const qualityReviewerTier =
          e.qualityReviewStatus === 'approved'
            || e.qualityReviewStatus === 'changes_required'
            ? (ctx.assignedTier === 'standard' ? 'complex' : 'standard')
            : (e.qualityReviewStatus === 'not_applicable' ? 'not_applicable' : 'skipped');
        e.agents = {
          implementer: ctx.assignedTier,
          implementerToolMode: ctx.implementerToolMode ?? 'full',
          specReviewer: specReviewerTier,
          qualityReviewer: qualityReviewerTier,
        };
      }

      if (e.fileArtifactsMissing === undefined) {
        e.fileArtifactsMissing = false;
      }

      if (e.specReviewReason === undefined) {
        e.specReviewReason = e.specReviewStatus === 'not_applicable'
          ? 'task produced no file artifacts to review'
          : '';
      }
      if (e.qualityReviewReason === undefined) {
        e.qualityReviewReason = e.qualityReviewStatus === 'not_applicable'
          ? 'task produced no file artifacts to review'
          : '';
      }

      const fallbackReport = (last.output
        ? parseStructuredReport(last.output)
        : { summary: '', filesChanged: [], validationsRun: [], deviationsFromBrief: [], unresolved: [], extraSections: {} }
      ) as unknown as { summary?: string; filesChanged?: string[]; validationsRun?: unknown[]; deviationsFromBrief?: unknown[]; unresolved?: unknown[]; extraSections?: Record<string, unknown> };
      if (e.implementationReport === undefined) {
        e.implementationReport = fallbackReport;
      }
      // v4.4.x: the Annotating handler is the canonical source for the
      // unified StructuredReport — when it ran, its output wins over any
      // earlier text-parsed shape set by the executor. Fall back to the
      // legacy parser only when the annotator did not run (e.g. terminal
      // short-circuit, register-block route).
      const annotatorReport = (state as { structuredReport?: unknown }).structuredReport;
      if (annotatorReport && typeof annotatorReport === 'object') {
        enriched.structuredReport = annotatorReport as RunResult['structuredReport'];
      } else if (enriched.structuredReport === undefined) {
        enriched.structuredReport = fallbackReport as RunResult['structuredReport'];
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

      if (ctx && e.models === undefined) {
        const implModel = (ctx.implementerProvider?.config as { model?: string } | undefined)?.model ?? '';
        const otherTier = ctx.assignedTier === 'standard' ? 'complex' : 'standard';
        const otherProvider = ctx.providers[otherTier];
        const otherModel = (otherProvider?.config as { model?: string } | undefined)?.model ?? null;
        e.models = {
          implementer: implModel,
          specReviewer: e.specReviewStatus === 'approved' || e.specReviewStatus === 'changes_required' ? otherModel : null,
          qualityReviewer: e.qualityReviewStatus === 'approved' || e.qualityReviewStatus === 'changes_required' ? otherModel : null,
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
      // A4b §2b — simplified in v4.4.x. The review chain handles artifact
      // verification; no duplicate cross-check here. Chain-failed and
      // read-only routes are already exempt.
      const chainAlreadyFailed = state.reviewPolicy !== 'none' && state.reviewVerdict === 'changes_required';
      const readOnlyRoutes = new Set(['audit', 'review', 'debug', 'investigate', 'research']);
      const route = typeof state.route === 'string' ? state.route : '';
      const isReadOnlyRoute = readOnlyRoutes.has(route);
      if (!chainAlreadyFailed && !isReadOnlyRoute) {
        // v4.4.x: rely on worker self-reporting for filesWritten
        // Artifact verification is handled by the review chain
      }

      // v4.4.x envelope assembly. Surface reviewer notes + verify result
      // as additive envelope fields. Status derivation:
      //   - last.status === 'error' (worker crashed) → 'error'
      //   - reviewVerdict === 'changes_required' → 'incomplete'
      //   - commits.length > 0 (write task) → 'ok' (commit landed)
      //   - otherwise → 'ok'
      if (state.specReviewerNotes !== undefined) {
        (enriched as { specReviewerNotes?: string }).specReviewerNotes = state.specReviewerNotes;
      }
      if (state.qualityReviewerNotes !== undefined) {
        (enriched as { qualityReviewerNotes?: string }).qualityReviewerNotes = state.qualityReviewerNotes;
      }
      if (state.reviewVerdict !== undefined) {
        (enriched as { reviewVerdict?: string }).reviewVerdict = state.reviewVerdict;
      }
      if (state.reviewFindings !== undefined) {
        (enriched as { reviewFindings?: unknown }).reviewFindings = state.reviewFindings;
      }
      if (state.specReviewError !== undefined) {
        (enriched as { specReviewError?: string }).specReviewError = state.specReviewError;
      }
      if (state.qualityReviewError !== undefined) {
        (enriched as { qualityReviewError?: string }).qualityReviewError = state.qualityReviewError;
      }
      if (state.reviewError !== undefined) {
        (enriched as { reviewError?: string }).reviewError = state.reviewError;
      }
      if (state.reworkError !== undefined) {
        (enriched as { reworkError?: string }).reworkError = state.reworkError;
      }
      if (state.reworkOutput !== undefined) {
        (enriched as { reworkOutput?: string }).reworkOutput = state.reworkOutput;
      }
      if (state.reworkApplied !== undefined) {
        (enriched as { reworkApplied?: boolean }).reworkApplied = state.reworkApplied;
      }
      if (state.verifyResult !== undefined) {
        (enriched as { verifyResult?: unknown }).verifyResult = state.verifyResult;
      }

      const commitsExist = Array.isArray(state.commits) && state.commits.length > 0;

      // v5 M4 fix: review_rejected is ONLY when review said changes_required AND
      // rework did NOT clean it up. If rework ran successfully (state.reworkApplied
      // is true AND state.reworkError is undefined), treat as cleared regardless
      // of the stale reviewVerdict slot.
      const reworkCleanedUp =
        state.reworkApplied === true && state.reworkError === undefined;
      const reviewRejected =
        state.reviewPolicy !== 'none' &&
        state.reviewVerdict === 'changes_required' &&
        !reworkCleanedUp;

      if (last.status === 'error') {
        enriched.status = 'error';
      } else if (reviewRejected) {
        enriched.status = 'incomplete';
        enriched.errorCode = 'review_rejected';
        const priorTr = (typeof enriched.terminationReason === 'object' && enriched.terminationReason !== null)
          ? enriched.terminationReason
          : undefined;
        enriched.terminationReason = {
          cause: 'incomplete',
          turnsUsed: priorTr?.turnsUsed ?? last.turns ?? 0,
          hasFileArtifacts: priorTr?.hasFileArtifacts ?? (Array.isArray(last.filesWritten) && last.filesWritten.length > 0),
          usedShell: priorTr?.usedShell ?? false,
          // v5 M3 fix: read truthful workerSelfAssessment instead of stamping
          // the retired 'done_with_concerns' value.
          workerSelfAssessment: ((last.workerStatus ?? state.workerStatus ?? null) as any),
          wasPromoted: false,
        };
      } else if (commitsExist) {
        enriched.status = 'ok';
      } else if (reworkCleanedUp && state.reviewPolicy !== 'none') {
        // v5 M4 fix: rework cleared all findings → promote to ok even though
        // review verdict slot still says changes_required.
        enriched.status = 'ok';
      }
      // else: leave status as worker reported (ok/incomplete/error)

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

    review: reviewHandler,
    rework: reworkHandler,
    annotating: annotator,

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

// ─── Compose handler (v5 I/O — pure serialization from state.gates) ───────────

/** Canonical list of 9 stage names, in chain order. */
const STAGE_NAMES = [
  'prepare',
  'register-block',
  'implement',
  'review',
  'rework',
  'commit',
  'annotate',
  'compose',
  'terminal',
] as const;

// ─── Compose path-3 (halt) helpers ───────────────────────────────────────────

function buildHaltFindings(gates: Record<string, StageGate<unknown>>): any[] {
  const out: any[] = [];
  const rg = gates['review'];
  if (rg?.outcome === 'advance') {
    const fp = (rg.payload as { findings?: any[] })?.findings ?? [];
    out.push(...fp);
  }
  const ig = gates['implement'];
  if (ig?.outcome === 'advance') {
    const fp = (ig.payload as { findings?: any[] })?.findings ?? [];
    out.push(...fp);
  }
  return out;
}

function buildHaltSummary(gates: Record<string, StageGate<unknown>>): string {
  const wg = gates['rework'];
  if (wg?.outcome === 'advance') {
    return (wg.payload as { summary?: string })?.summary ?? '';
  }
  const ig = gates['implement'];
  if (ig?.outcome === 'advance') {
    return (ig.payload as { summary?: string })?.summary ?? '';
  }
  return '';
}

function buildHaltFilesChanged(gates: Record<string, StageGate<unknown>>): string[] {
  const cg = gates['commit'];
  if (cg?.outcome === 'advance' && (cg.payload as { kind?: string }).kind === 'committed') {
    return (cg.payload as { filesChanged?: string[] })?.filesChanged ?? [];
  }
  return [];
}

function buildHaltCommitSha(gates: Record<string, StageGate<unknown>>): string | null {
  const cg = gates['commit'];
  if (cg?.outcome === 'advance' && (cg.payload as { kind?: string }).kind === 'committed') {
    return (cg.payload as { commitSha?: string })?.commitSha ?? null;
  }
  return null;
}


function makeComposeTelemetry(state: LifecycleState) {
  const gates = state.gates ?? {};

  let totalDurationMs = 0;
  let totalCostUSD: number | null = null;
  let workerSelfAssessment: WorkerSelfAssessment | null = null;
  let reviewVerdict: 'approved' | 'changes_required' | null = null;
  let commitOutcome: 'committed' | 'no_op' | 'not_applicable' = 'not_applicable';
  let stopReason: StageStopReason = 'normal';
  let haltedStage: string | null = null;

  for (const gate of Object.values(gates)) {
    totalDurationMs += gate.telemetry.durationMs ?? 0;
    const c = gate.telemetry.costUSD;
    if (c !== null && c !== undefined) {
      totalCostUSD = (totalCostUSD ?? 0) + c;
    }
    if (gate.telemetry.stopReason !== 'normal' && stopReason === 'normal') {
      stopReason = gate.telemetry.stopReason as StageStopReason;
    }
    if (gate.outcome === 'halt' && haltedStage === null) {
      haltedStage = gate.telemetry.stageLabel;
    }
  }

  // workerSelfAssessment: latest of (rework ?? implement)
  const reworkSa = (gates['rework']?.payload as { workerSelfAssessment?: WorkerSelfAssessment } | null)?.workerSelfAssessment;
  const implSa = (gates['implement']?.payload as { workerSelfAssessment?: WorkerSelfAssessment } | null)?.workerSelfAssessment;
  workerSelfAssessment = reworkSa ?? implSa ?? null;

  // reviewVerdict from review gate
  const reviewGate = gates['review'];
  if (reviewGate?.outcome === 'advance') {
    reviewVerdict = (reviewGate.payload as { verdict?: 'approved' | 'changes_required' }).verdict ?? null;
  }

  // commitOutcome
  const commitGate = gates['commit'];
  if (commitGate?.outcome === 'advance') {
    const cp = commitGate.payload as { kind?: string };
    commitOutcome = cp.kind === 'committed' ? 'committed' : 'no_op';
  }

  // Build telemetry.stages: always 9 entries
  const stages = STAGE_NAMES.map((name) => {
    const gate = gates[name];
    if (!gate) {
      return { name, outcome: 'not_run' as const, durationMs: 0, costUSD: null };
    }
    return {
      name,
      outcome: gate.outcome as 'advance' | 'skip' | 'halt',
      comment: gate.comment,
      durationMs: gate.telemetry.durationMs,
      costUSD: gate.telemetry.costUSD,
    };
  });

  return { totalDurationMs, totalCostUSD, workerSelfAssessment, reviewVerdict, commitOutcome, stopReason, haltedStage, stages };
}

/**
 * v5 compose: pure serialization of the wire envelope from state.gates.
 * Four paths (spec §5.8):
 *  1. normal — annotate.payload copied verbatim
 *  2. register-block — synthesize from register-block gate
 *  3. pre-annotate halt — synthesize from halting gate
 *  4. internal_state_corrupted — degenerate fallback
 */
export async function composeHandler(state: LifecycleState): Promise<StageGate<ComposePayload>> {
  const t0 = Date.now();
  const route = state.route ?? '';
  const gates = state.gates ?? {};
  const halted = state.halted === true;
  const annotateGate = gates['annotate'];

  let payload: ComposePayload;

  if (route === 'register-context-block') {
    // Path 2 — register-block synthesis
    const rbGate = gates['register-block'];
    const rbPayload = rbGate?.payload as { blockId?: string; bytes?: number } | null;
    const blockId: string | null = rbPayload?.blockId ?? null;
    payload = {
      completed: rbGate?.outcome === 'advance',
      message: rbGate?.outcome === 'advance'
        ? `Context block ${blockId} registered (${rbPayload?.bytes ?? 0} bytes)`
        : `Block registration failed: ${rbGate?.comment ?? 'unknown'}`,
      findings: [],
      summary: '',
      filesChanged: [],
      commitSha: null,
      blockId,
      telemetry: makeComposeTelemetry(state),
    };
  } else if (annotateGate?.outcome === 'advance') {
    // Path 1 — normal (annotate ran)
    // AnnotatePayload has 6 fields; ComposePayload adds `blockId` + `telemetry`.
    // Explicitly set blockId=null for non-register routes so the wire shape is
    // complete (not undefined).
    const ap = annotateGate.payload as { completed: boolean; message: string; findings: ComposePayload['findings']; summary: string; filesChanged: string[]; commitSha: string | null };
    payload = {
      completed: ap.completed,
      message: ap.message,
      findings: ap.findings,
      summary: ap.summary,
      filesChanged: ap.filesChanged,
      commitSha: ap.commitSha,
      blockId: null,
      telemetry: makeComposeTelemetry(state),
    };
  } else if (halted) {
    // Path 3 — pre-annotate halt synthesis
    const haltedEntry = Object.values(gates).find(g => g.outcome === 'halt');
    const haltedStageName = haltedEntry?.telemetry.stageLabel ?? 'unknown';
    payload = {
      completed: false,
      message: `${haltedStageName} halted: ${haltedEntry?.comment ?? 'unknown halt'}`,
      findings: buildHaltFindings(gates),
      summary: buildHaltSummary(gates),
      filesChanged: buildHaltFilesChanged(gates),

      commitSha: buildHaltCommitSha(gates),

      blockId: (gates['register-block']?.outcome === 'advance'
        ? ((gates['register-block'].payload as { blockId?: string })?.blockId ?? null)
        : null) as string | null,
      telemetry: makeComposeTelemetry(state),
    };
  } else {
    // Path 4 — internal_state_corrupted degenerate fallback
    payload = {
      completed: false,
      message: 'internal_state_corrupted',
      findings: [],
      summary: '',
      filesChanged: [],
      commitSha: null,
      blockId: null,
      telemetry: {
        totalDurationMs: 0,
        totalCostUSD: null,
        workerSelfAssessment: null,
        reviewVerdict: null,
        commitOutcome: 'not_applicable',
        stopReason: 'transport_error' as StageStopReason,
        haltedStage: null,
        stages: STAGE_NAMES.map(name => ({ name, outcome: 'not_run' as const, durationMs: 0, costUSD: 0 })),
      },
    };
  }

  return {
    outcome: 'advance',
    payload,
    telemetry: {
      stageLabel: 'compose',
      durationMs: Date.now() - t0,
      costUSD: null,
      turnsUsed: 0,
      stopReason: 'normal',
    },
  };
}
