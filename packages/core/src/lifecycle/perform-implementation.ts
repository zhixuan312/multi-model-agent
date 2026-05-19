// Extracted executor closure from task-runner.ts.
// This function orchestrates the implementation stage: read-route sequential
// criteria loop or write-route single worker turn, populates state.lastRunResult.

import type { TaskSpec, RuntimeRunResult, Provider } from '../types.js';
import type { LifecycleState } from './stage-plan-types.js';
import type { ExecutionContext } from './lifecycle-context.js';
import { assembleRunResult } from '../providers/assemble-run-result.js';
import { retryableFor } from '../error-codes.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
import { parseFindings } from './findings-parser.js';
import { mergeStageStats } from './merge-stage-stats.js';
import { startProgressWatchdog, recordPostHocSignals } from '../bounded-execution/progress-watchdog.js';
import { resolveSubtypeSpec, isReadOnlyRoute } from './parallel-criteria-routes.js';
import { runReadRouteImplementer } from './handlers/read-route-implementer.js';
import { HUMAN_LABEL } from './stage-labels.js';
import { readFile as fsReadFile } from 'fs/promises';

function safeTracker(fn: () => void, ctx: { logger?: { error: (kind: string, err: unknown) => void } }): void {
  try { fn(); } catch (e) { ctx.logger?.error('heartbeat_call_failed', e); }
}

export async function performImplementation(state: LifecycleState): Promise<void> {
  const task = state.task as TaskSpec | undefined;
  const ctx = state.executionContext as ExecutionContext | undefined;
  if (!task || !ctx) {
    throw new Error(`performImplementation: state.task / state.executionContext not set for route '${state.route}'`);
  }
  // No tier rotation — tasks stay on their assigned tier per the v0.5 design.
  // The escalation/policy.ts pickEscalation() was used for an attempt-2 swap
  // that this codebase doesn't need; deleted along with the escalation/ dir.
  const implTier = ctx.assignedTier;
  const decision = { impl: implTier };
  const provider = ctx.providers[implTier] as Provider | undefined;
  if (!provider) {
    state.lastRunResult = {
      output: '',
      status: 'error',
      usage: { inputTokens: 0, outputTokens: 0 },
      turns: 0,
      filesWritten: [],
      outputIsDiagnostic: true,
      escalationLog: [],
      error: `no provider configured for tier '${implTier}'`,
      errorCode: 'all_tiers_unavailable',
      workerStatus: 'failed',
    } as unknown as RuntimeRunResult;
    state.terminal = true;
    return undefined;
  }
  // Read-only routes (audit / review / debug / investigate / research)
  // run the sequential criteria loop on one complex session. The
  // (route, subtype) pair resolves to a per-subtype spec from the
  // tool's SUBTYPES map; the dispatcher uses that to build the cached
  // prefix + per-criterion suffix.
  const route = state.route ?? 'delegate';
  if (state.toolCategory === 'read_only' && isReadOnlyRoute(route)) {
    try {
      const taskWithSubtype = task as TaskSpec & { subtype?: string };
      const routeSpec = resolveSubtypeSpec(route, taskWithSubtype.subtype);
      const taskWithFiles = task as TaskSpec & { filePaths?: string[]; document?: string };
      const filePaths = Array.isArray(taskWithFiles.filePaths) ? taskWithFiles.filePaths : [];
      const preReadFiles: Record<string, string> = {};
      for (const fp of filePaths) {
        try {
          preReadFiles[fp] = await fsReadFile(fp, 'utf8');
        } catch {
          // tolerated — sub-worker can read on demand via tools
        }
      }
      // Target content for the cached prefix. Preference order:
      //   1. parallelTarget — pure user question/work/problem, no
      //      legacy format spec (set by the route's buildTaskSpec).
      //   2. document — inlined doc (audit's primary input shape).
      //   3. task.prompt — last-resort fallback. AVOID: it embeds the
      //      legacy monolithic format spec (## Summary / ## Citations
      //      for investigate, etc.), which competes with our `## Finding
      //      N:` shape and confuses the worker about output format.
      const taskWithTarget = task as TaskSpec & { parallelTarget?: string; document?: string };
      const targetContent =
        (taskWithTarget.parallelTarget && taskWithTarget.parallelTarget.trim().length > 0)
          ? taskWithTarget.parallelTarget
          : (taskWithTarget.document && taskWithTarget.document.trim().length > 0)
            ? taskWithTarget.document
            : task.prompt;
      // /research: replace the standard cachedPrefix with one built from a
      // pre-loop plan turn + deterministic Step-2 fan-out. The N-criterion loop
      // below then synthesises against the EvidencePack-bearing prefix.
      let cachedPrefix: string;
      if (route === 'research') {
        // Pull research-specific task fields from the TaskSpec contract.
        const r = task.research;
        if (!r) throw new Error('research_route_missing_input');
        const { runResearchPreLoop } = await import('./research-pre-loop.js');
        const preLoop = await runResearchPreLoop({
          session: ctx.getSession(decision.impl),
          researchQuestion: r.researchQuestion,
          background:       r.background,
          resolvedContextBlocks: r.resolvedContextBlocks ?? [],
          cfg: {
            ...ctx.config.research,
            userSources: r.userSources ?? [],
          },
        });
        cachedPrefix = preLoop.cachedPrefix;
      } else {
        cachedPrefix = routeSpec.buildPrefix({
          document: targetContent,
          preReadFiles,
          filePaths,
        });
      }
      // v4.4.x: single complex session per task, sequential for-loop over
      // criteria. Earlier criteria's tool results stay in the session
      // context so later criteria don't re-discover the same files.
      const session = ctx.getSession(decision.impl);
      const dispatchResult = await runReadRouteImplementer({
        session,
        cachedPrefix,
        criteria: routeSpec.criteria,
        buildSuffix: routeSpec.buildSuffix,
        legalOutcomes: routeSpec.semantics.legalOutcomes,
        warnSink: (event, data) => {
          try {
            ctx.envelope?.recordValidationWarning({
              rule: event,
              path: `${data['reasonCode'] ?? 'unknown'}:${String(data['droppedFindingHeading'] ?? '').slice(0, 120)}`,
            });
          } catch { /* envelope sealed — race with terminal stage, harmless */ }
        },
      });

      const totalCriteria = routeSpec.criteria.length;
      const failedCount = dispatchResult.criteriaErrors.length;
      const succeededCount = totalCriteria - failedCount;
      const majorityThreshold = Math.ceil(totalCriteria / 2);
      // deriveCompletion for read-routes requires criteriaSucceeded.length > 0
      // to consider a task completed. Surfaced via smoke: without this every
      // read-route run sealed as worker_status=failed, terminal_status=error
      // because lastRunResult.criteriaSucceeded was never populated.
      const erroredCriterionIds = new Set(dispatchResult.criteriaErrors.map(e => e.criterionId));
      const criteriaSucceeded: string[] = routeSpec.criteria
        .filter(c => !erroredCriterionIds.has(c.id))
        .map(c => c.id);
      const status = succeededCount === 0
        ? 'error'
        : succeededCount >= majorityThreshold ? 'ok' : 'incomplete';
      const incompleteReason = succeededCount > 0 && succeededCount < majorityThreshold
        ? ('missing_sections' as const)
        : undefined;

      const terminationCause: 'finished' | 'incomplete' | 'error' = succeededCount === 0
        ? 'error'
        : succeededCount >= majorityThreshold ? 'finished' : 'incomplete';
      const terminationReason = {
        cause: terminationCause,
        turnsUsed: dispatchResult.turns,
        hasFileArtifacts: false,
        usedShell: false,
        workerSelfAssessment: succeededCount === 0 ? 'failed' as const : 'done' as const,
        wasPromoted: false,
      };
      state.lastRunResult = {
        output: dispatchResult.synthesizedOutput,
        status,
        usage: dispatchResult.usage,
        turns: dispatchResult.turns,
        filesWritten: [],
        outputIsDiagnostic: false,
        escalationLog: [],
        workerStatus: succeededCount === 0 ? 'failed' : 'done',
        terminationReason,
        findings: dispatchResult.findings,
        criteriaErrors: dispatchResult.criteriaErrors,
        criteriaSucceeded,
        findingsOutcome: dispatchResult.findingsOutcome,
        findingsOutcomeReason: dispatchResult.findingsOutcomeReason,
        outcomeInferred: dispatchResult.outcomeInferred,
        outcomeMalformed: dispatchResult.outcomeMalformed,
        ...(incompleteReason && { incompleteReason }),
      } as unknown as RuntimeRunResult;

      mergeStageStats(state, 'implementing', {
        inputTokens: dispatchResult.usage.inputTokens,
        outputTokens: dispatchResult.usage.outputTokens,
        cachedReadTokens: dispatchResult.usage.cachedReadTokens,
        cachedNonReadTokens: dispatchResult.usage.cachedNonReadTokens,
        turnCount: dispatchResult.turns,
        costUSD: dispatchResult.costUSD,
        durationMs: dispatchResult.durationMs,
      }, {
        tier: ctx.assignedTier,
        model: (ctx.implementerProvider?.config as { model?: string } | undefined)?.model ?? null,
        findingsOutcome: dispatchResult.findingsOutcome,
        findingsOutcomeReason: dispatchResult.findingsOutcomeReason,
        outcomeInferred: dispatchResult.outcomeInferred,
        outcomeMalformed: dispatchResult.outcomeMalformed,
      });
      if (status !== 'ok') state.terminal = true;
      return undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.lastRunResult = {
        output: '',
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 0,
        filesWritten: [],
        outputIsDiagnostic: true,
        escalationLog: [],
        error: message,
        errorCode: 'runner_crash',
        workerStatus: 'failed',
      } as unknown as RuntimeRunResult;
      state.terminal = true;
      return undefined;
    }
  }

  // Build the watchdog config once, just before the session.send call:
  const wdConfig = {
    enabled: ctx.config?.defaults?.progressWatchdogEnabled ?? true,
    thrashTurns: ctx.config?.defaults?.thrashTurns ?? 50,
    thrashWallClockMs: ctx.config?.defaults?.thrashWallClockMs ?? 1_200_000,
    thrashSoftWallClockMs: ctx.config?.defaults?.thrashWallClockMs
      ? Math.floor((ctx.config.defaults.thrashWallClockMs ?? 1_200_000) / 2)
      : 600_000,
  };
  // state2 carries the timer's "fired" bit so recordPostHocSignals knows whether
  // the abort came from the watchdog vs. some other cancellation.
  const wdState2 = { fired: false };

  // Wire the watchdog. ctx.stall.controller is the existing AbortController
  // passed into session.send via TurnOpts.signal — when the watchdog fires,
  // the controller's abort propagates into the active subprocess.
  const disposeWatchdog = startProgressWatchdog({
    state,
    controller: ctx.stall.controller,
    emit: (_event) => { /* signals flow via envelope + log-writer */ },
    config: wdConfig,
    taskIndex: ctx.taskIndex,
    batchId: ctx.batchId,
    state2: wdState2,
  });

  try {
    // v0.5: single cached session per (task, tier) — owned by task-runner.ts's
    // sessions Map and closed in finally{} by closeSessions(). No retry
    // wrapper, no per-attempt respawn; SDKs handle transport retry internally
    // on the same persistent session.
    const session = ctx.getSession(decision.impl);
    const turn = await session.send(task.prompt, {
      stageLabel: HUMAN_LABEL.implementing,
      signal: ctx.stall.controller.signal,
    });
    const raw = assembleRunResult(turn) as RuntimeRunResult;
    // Match the structured `terminationReason` shape that the old
    // delegate-with-escalation wrapper used to populate (consumed by
    // golden-checked downstream telemetry).
    const usedShell = Boolean(raw.usedShell);
    const cause = raw.status === 'ok' ? 'finished'
      : raw.status === 'incomplete' ? 'incomplete'
      : 'error';
    const result: RuntimeRunResult = {
      ...raw,
      terminationReason: {
        cause,
        turnsUsed: raw.turns ?? 0,
        hasFileArtifacts: Array.isArray(raw.filesWritten) && raw.filesWritten.length > 0,
        usedShell,
        workerSelfAssessment: raw.workerStatus ?? null,
        wasPromoted: false,
      },
      escalationLog: [],
      // Match the errorCode + retryable defaults the old escalation wrapper
      // used to populate for non-ok statuses (consumed by golden-checked envelope).
      ...(raw.status !== 'ok' && {
        errorCode: raw.errorCode ?? raw.status,
        retryable: raw.retryable ?? retryableFor(raw.status),
      }),
    } as unknown as RuntimeRunResult;
    // Canonical findings extraction: 4.7.4 ships `## Finding N:` as the
    // wire-grade format and bridges results[N].findings through baseline-handlers.
    // Read-route-implementer parses + populates these directly. The standard
    // (write/assist) path historically left `findings` undefined, so any tool
    // that doesn't hit the read-route branch (notably the retry tool re-running
    // an investigate task) silently dropped the worker's emitted Finding blocks.
    // Parse them here so the bridge has data to push into envelope.findings.
    // criterionId = the route so per-route warn telemetry stays attributable.
    const findingsWarnSink = (event: string, data: Record<string, unknown>) => {
      // Surface dropped/malformed Finding blocks on the envelope so a user reading
      // the verbose log or per-task validationWarnings can see why a Finding
      // didn't materialize. Pre-this-wire, parser drops were invisible.
      try {
        ctx.envelope?.recordValidationWarning({
          rule: event,
          path: `${data['reasonCode'] ?? 'unknown'}:${String(data['droppedFindingHeading'] ?? '').slice(0, 120)}`,
        });
      } catch { /* envelope sealed — race with terminal stage, harmless */ }
    };
    const parsedFindings = (result as { findings?: unknown }).findings === undefined && result.output
      ? parseFindings(result.output, `${route}-standard`, undefined, findingsWarnSink)
      : null;
    const enrichedResult: RuntimeRunResult = {
      ...result,
      ...(result.implementationReport === undefined && result.output && { implementationReport: parseStructuredReport(result.output) }),
      ...(parsedFindings && parsedFindings.findings.length > 0 && {
        findings: parsedFindings.findings,
        findingsOutcome: parsedFindings.outcome,
      }),
    } as unknown as RuntimeRunResult;
    const filesWritten = Array.isArray(result.filesWritten) ? result.filesWritten.length : 0;
    safeTracker(() => ctx.heartbeat?.updateProgress(filesWritten), ctx);
    state.lastRunResult = enrichedResult;

    // Post-hoc: turn-count thrash + scope-violation (replaces nothing existing;
    // adds new signals state for sub-project B's annotator).
    await recordPostHocSignals(
      state,
      enrichedResult.turns ?? 0,
      wdConfig,
      (_event) => { /* signals flow via envelope + log-writer */ },
      ctx.taskIndex,
      ctx.batchId,
    );
    // Record the implementer's per-stage cost so emit_task_terminal +
    // wire task.completed include it in the totals + per-stage breakdown.
    // Cost field lookup matches the canonical-then-legacy fallback used
    // in delegate-with-escalation: `cost.costUSD` was the original field
    // before assembleRunResult moved the value to top-level
    // `actualCostUSD` (the current source of truth from claude/codex
    // turns). Without the actualCostUSD fallback every claude-tier
    // implementing stage records cost=null and telemetry under-reports.
    const costUSDForStage = result.cost?.costUSD ?? (result as { actualCostUSD?: number | null }).actualCostUSD ?? null;
    mergeStageStats(state, 'implementing', {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      cachedReadTokens: result.usage.cachedReadTokens ?? 0,
      cachedNonReadTokens: result.usage.cachedNonReadTokens ?? 0,
      turnCount: result.turns ?? 0,
      costUSD: costUSDForStage,
      durationMs: result.durationMs ?? null,
      filesWrittenCount: Array.isArray(result.filesWritten) ? result.filesWritten.length : 0,
    }, {
      tier: ctx.assignedTier,
      model: (ctx.implementerProvider?.config as { model?: string } | undefined)?.model ?? null,
    });
    safeTracker(() => ctx.heartbeat?.applyCost({ costUSD: costUSDForStage ?? 0, costDeltaVsMainUSD: 0 }), ctx);
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
      filesWritten: [],
      outputIsDiagnostic: true,
      escalationLog: [],
      error: message,
      errorCode: 'runner_crash',
      workerStatus: 'failed',
    } as unknown as RuntimeRunResult;
    state.terminal = true;
  } finally {
    disposeWatchdog();
  }
  return undefined;
}
