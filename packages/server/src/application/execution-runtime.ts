// ExecutionRuntime — the application layer between transport adapters and the
// core two-phase pipeline. Adapters (REST today; future protocols) validate
// their wire input into a TaskInput, build a CallerContext at their boundary,
// and call submit(). Everything downstream of validation — tier resolution,
// skill loading, project reservation, per-type preprocessing, pipeline
// invocation, terminal envelope construction, telemetry — lives here and never
// touches a transport request object.

import { randomUUID } from 'node:crypto';
import {
  getTypeConfig,
  oppositeAgent,
  loadSkill,
  resolveAgent,
  runTwoPhasePipeline,
  WorktreeManager,
  type SkillPair,
  type TaskInput,
  type MultiModelConfig,
  type AgentType,
  type TaskRegistry,
  type ProjectContext,
  type ResolvedAgent,
} from '@zhixuan92/multi-model-agent-core';
import { resolveRateCard, priceTokens } from '@zhixuan92/multi-model-agent-core/bounded-execution/cost-compute';
import type { EnvelopeBus } from '@zhixuan92/multi-model-agent-core/events/envelope-bus';
import type { CallerContext } from './caller-context.js';
import { ExecutionScope } from './execution-scope.js';
import type { ExecutionStore } from './execution-store.js';
import type { ProjectRegistry } from './project-registry.js';
import type { TaskEntry } from '@zhixuan92/multi-model-agent-core';
import { SKILLS_DIR } from './skills-dir.js';
import { buildGoalCondition } from './goal-conditions.js';
import { buildErrorEnvelope, tryParseJson } from './result-shape.js';
import { buildEnvelopeSnapshot } from './telemetry-snapshot.js';
import { PREPROCESSORS, PreprocessFailure, type PreprocessResult } from './preprocessors/index.js';

export interface ExecutionRuntimeDeps {
  config: MultiModelConfig;
  bus: EnvelopeBus;
  taskRegistry: TaskRegistry;
  projectRegistry: ProjectRegistry;
  /** Durable execution records — admission is persisted before the handle is
   *  returned; terminal transitions mirror the in-memory registry. */
  store: ExecutionStore;
  /** Injectable agent resolver — tests substitute mock providers; production
   *  uses the config-driven resolveAgent (same pattern as PipelineInput's
   *  runAcceptanceCommand). */
  resolveAgentFn?: (tier: AgentType, config: MultiModelConfig) => ResolvedAgent;
}

export type SubmitError =
  | { kind: 'agent_not_configured'; message: string }
  | { kind: 'skill_load_failed'; message: string }
  | { kind: 'project_reservation'; code: string; message: string };

export type SubmitResult =
  | { ok: true; taskId: string }
  | { ok: false; error: SubmitError };

export type CancelResult =
  | { outcome: 'not_found' }
  | { outcome: 'terminal'; entry: TaskEntry }
  | { outcome: 'requested'; entry: TaskEntry };

export class ExecutionRuntime {
  /** Live abort channels, keyed by taskId. An entry exists from admission until
   *  the execution's finally block — cancel() fires the scope's signal, the
   *  provider guards terminate the worker process group, and the terminal CAS
   *  decides between cancelled and a completed/failed that won the race. */
  private readonly liveScopes = new Map<string, ExecutionScope>();

  constructor(private readonly deps: ExecutionRuntimeDeps) {}

  /**
   * Request cooperative cancellation. 202-semantics: 'requested' means the
   * abort channel fired, not that the work already stopped — the task stays
   * `pending` (with cancellationRequestedAt set) until the runner confirms
   * termination, then transitions to `cancelled` unless completion won the
   * race. Idempotent; terminal tasks report 'terminal' with their final entry.
   */
  cancel(taskId: string): CancelResult {
    const res = this.deps.taskRegistry.requestCancel(taskId);
    if (res.outcome === 'not_found') return { outcome: 'not_found' };
    if (res.outcome === 'terminal') return { outcome: 'terminal', entry: res.entry! };
    this.deps.store.requestCancel(taskId);
    this.liveScopes.get(taskId)?.abort('cancel requested by caller');
    return { outcome: 'requested', entry: res.entry! };
  }

  /**
   * Synchronous admission: resolve tiers/agents/skills, reserve the project,
   * register the task, and schedule the async execution. Returns the taskId the
   * adapter surfaces to the caller; the execution result arrives via polling.
   */
  async submit(input: TaskInput, caller: CallerContext): Promise<SubmitResult> {
    const { deps } = this;
    const cwd = caller.projectRoot;

    const typeConfig = getTypeConfig(input.type);
    const implTier = (input as Record<string, unknown>).agentTier as AgentType | undefined ?? typeConfig.defaultTier;
    const revTier = oppositeAgent(implTier);
    // execute_plan is always reviewed: contract-first completion scoring derives
    // contract satisfaction from the reviewer's tasks[], so an unreviewed execute-plan
    // has no scoring source. This overrides any caller-requested 'none'.
    const reviewPolicy = input.type === 'orchestrate'
      ? 'none'
      : input.type === 'execute_plan'
        ? 'reviewed'
        : (input.reviewPolicy ?? 'reviewed');
    // Raw caller intent: undefined when omitted. Journal routes force review only when the
    // caller explicitly asked for it; otherwise the deterministic invariants decide.
    const callerForcedReview = input.reviewPolicy === 'reviewed';

    const resolve = deps.resolveAgentFn ?? resolveAgent;
    let implAgent: ResolvedAgent, revAgent: ResolvedAgent;
    try {
      implAgent = resolve(implTier, deps.config);
      revAgent = resolve(revTier, deps.config);
    } catch (err) {
      return { ok: false, error: { kind: 'agent_not_configured', message: err instanceof Error ? err.message : 'Agent resolution failed' } };
    }

    let skills: SkillPair;
    try {
      const subtype = (input as Record<string, unknown>).subtype as string | undefined;
      skills = await loadSkill(input.type, SKILLS_DIR, subtype);
    } catch (err) {
      return { ok: false, error: { kind: 'skill_load_failed', message: err instanceof Error ? err.message : 'Skill load failed' } };
    }

    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      return { ok: false, error: { kind: 'project_reservation', code: reserveResult.error, message: reserveResult.message } };
    }
    const pc = reserveResult.projectContext;
    pc.lastActivityAt = Date.now();
    deps.projectRegistry.cancelReservation(cwd);

    // Register task in TaskRegistry AND persist the admission record — a
    // handle that exists is always a handle that survives a restart. The
    // scope (the live abort channel) is created here too, so a cancel that
    // lands before the async executor starts still aborts the execution.
    const taskId = randomUUID();
    deps.taskRegistry.register(taskId, cwd, input.type);
    deps.store.admit(taskId, input.type, cwd, process.pid);
    const scope = new ExecutionScope(taskId);
    this.liveScopes.set(taskId, scope);

    // Emit task-created diagnostic for observability.
    deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_created', fields: { batch_id: taskId, route: input.type } });

    // Run the pipeline asynchronously via setImmediate.
    const startedAtMs = Date.now();
    setImmediate(() => {
      void this.execute({
        taskId, input, caller, cwd, pc, skills, scope,
        implAgent, revAgent, implTier, revTier,
        reviewPolicy, callerForcedReview, startedAtMs,
        worktree: typeConfig.worktree,
        sandbox: typeConfig.sandbox,
      });
    });

    return { ok: true, taskId };
  }

  private async execute(run: {
    taskId: string;
    input: TaskInput;
    caller: CallerContext;
    cwd: string;
    pc: ProjectContext;
    skills: SkillPair;
    /** Created at admission (before preprocessing): every provider session this
     *  execution opens receives scope.signal, and every acquired resource
     *  registers its release here — drained in the finally so a crashing
     *  pipeline can never leak a pin. */
    scope: ExecutionScope;
    implAgent: ResolvedAgent;
    revAgent: ResolvedAgent;
    implTier: AgentType;
    revTier: AgentType;
    reviewPolicy: 'reviewed' | 'none';
    callerForcedReview: boolean;
    startedAtMs: number;
    worktree: boolean;
    sandbox: 'read-only' | 'cwd-only';
  }): Promise<void> {
    const { deps } = this;
    const {
      taskId, input, caller, cwd, pc, scope, implAgent, revAgent,
      implTier, revTier, reviewPolicy, callerForcedReview, startedAtMs,
    } = run;
    let { skills } = run;
    const contextBlockStore = pc.contextBlocks;
    const sessionIds = (input as Record<string, unknown>).sessionIds as { implementer?: string; reviewer?: string } | undefined;
    const { type: _type, agentTier: _tier, reviewPolicy: _review, sessionIds: _sessions, contextBlockIds: _blocks, ...payload } = input as Record<string, unknown>;

    // Terminal cancelled path — shared by the pre-start check, the pipeline
    // aborted mapping, and the crash path when the abort raced an error.
    const finishCancelled = (durationMs: number, envelope: Record<string, unknown>) => {
      deps.taskRegistry.cancel(taskId, envelope);
      deps.store.cancel(taskId, JSON.stringify(envelope));
      deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_cancelled', fields: { task_id: taskId, tool: input.type, duration_ms: durationMs } });
      process.stderr.write(
        `[mma] event=task_cancelled ts=${new Date().toISOString()} task=${taskId} route=${input.type} duration_ms=${durationMs}\n`,
      );
    };

    try {
      // Cancelled before the executor even started (cancel raced setImmediate):
      // finish immediately with zero provider sessions.
      if (scope.signal.aborted) {
        finishCancelled(0, buildErrorEnvelope(taskId, input.type, { code: 'aborted', message: 'Execution cancelled by caller before it started' }, 'cancelled'));
        return;
      }
      process.stderr.write(
        `[mma] event=executor_started ts=${new Date().toISOString()} task=${taskId} route=${input.type}\n`,
      );
      const implementerGoal = buildGoalCondition(input.type, 'implementer', skills.implement);
      const reviewerGoal = buildGoalCondition(input.type, 'reviewer', skills.review);

      // ── Per-type pre-processing (execute_plan contract parse, journal candidate
      //    injection, spec/plan outputPath + copyToWorktree, research evidence).
      //    A PreprocessFailure fails the task terminally with zero provider
      //    sessions opened — the client learns of it by polling. ──
      let pre: PreprocessResult = {};
      const preprocessor = PREPROCESSORS[input.type];
      if (preprocessor) {
        try {
          pre = await preprocessor({
            taskId, cwd, payload, input, skills,
            signal: scope.signal,
            config: deps.config,
            implementerProvider: implAgent.provider,
          });
        } catch (err) {
          if (err instanceof PreprocessFailure) {
            const envelope = buildErrorEnvelope(taskId, input.type, { code: err.code, message: err.message });
            deps.taskRegistry.fail(taskId, envelope);
            deps.store.fail(taskId, JSON.stringify(envelope));
            return;
          }
          throw err;
        }
        if (pre.skills) skills = pre.skills;
        if (pre.totalTasks !== undefined) {
          const entry = deps.taskRegistry.get(taskId);
          if (entry) entry.totalTasks = pre.totalTasks;
        }
      }

      // ── Context block resolution: resolve IDs → content, pin for duration ──
      // Missing blocks are skipped (soft) — the in-memory store loses blocks
      // on server restart, and a stale block should not kill the task.
      const inputBlockIds = (input.contextBlockIds ?? []) as string[];
      let resolvedContextBlocks: string[] | undefined;
      if (inputBlockIds.length > 0) {
        const blocks: string[] = [];
        for (const id of inputBlockIds) {
          const content = contextBlockStore.get(id);
          if (content === undefined) {
            process.stderr.write(`[mma] context_block_skipped id=${id} task=${taskId} reason=not_found\n`);
            continue;
          }
          blocks.push(content);
          contextBlockStore.pin(id);
          // Scope-registered so a crashing pipeline releases the pin too —
          // previously a runner crash left the block pinned forever (DELETE
          // /context-blocks/:id would 409 until server restart).
          scope.registerCleanup(() => contextBlockStore.unpin(id));
        }
        if (blocks.length > 0) resolvedContextBlocks = blocks;
      }

      const enrichedPayload = pre.payloadSuffix
        ? `${JSON.stringify(payload, null, 2)}${pre.payloadSuffix}`
        : JSON.stringify(payload, null, 2);

      const onPhaseChange = (phase: 'implementing' | 'reviewing') => {
        deps.taskRegistry.setPhase(taskId, phase);
      };

      // Reap worktrees under <cwd>/.mma/worktrees/ orphaned by a prior process kill
      // (tsx-restart / SIGKILL) that could not run its own cleanup. A worktree's shortId
      // is its owning task's `taskId.slice(0, 8)`, so a still-in-flight task is never
      // reaped. This runs before the pipeline creates THIS task's worktree, and only for
      // worktree-enabled types. Best-effort — a reap failure never blocks the dispatch.
      if (run.worktree) {
        await new WorktreeManager()
          .reapOrphans(cwd, (shortId) =>
            deps.taskRegistry.allInFlight().some((e) => e.taskId.startsWith(shortId)),
          )
          .catch(() => undefined);
      }

      const result = await runTwoPhasePipeline({
        type: input.type,
        implementerSkill: skills.implement,
        reviewerSkill: skills.review,
        abortSignal: scope.signal,
        taskPayload: enrichedPayload,
        implementerProvider: implAgent.provider,
        reviewerProvider: revAgent.provider,
        implementerTier: implTier,
        reviewerTier: revTier,
        reviewPolicy,
        cwd,
        sandboxPolicy: run.sandbox,
        // Git detection lives in the shared WorktreeManager (WorktreeManager.isGitRepo):
        // for a non-git target it runs in-place, so the route just passes the type's intent.
        worktreeEnabled: run.worktree,
        taskId,
        implementerGoal,
        reviewerGoal,
        bus: deps.bus,
        onPhaseChange,
        forceReview: callerForcedReview,
        ...(pre.applyDecisions && { applyDecisions: pre.applyDecisions }),
        ...(pre.dispatchedTasks && { dispatchedTasks: pre.dispatchedTasks }),
        ...(pre.copyToWorktree && { copyToWorktree: pre.copyToWorktree }),
        ...(pre.acceptanceTestSnapshot && { acceptanceTestSnapshot: pre.acceptanceTestSnapshot }),
        ...(sessionIds?.implementer && { resumeImplementer: sessionIds.implementer }),
        ...(sessionIds?.reviewer && { resumeReviewer: sessionIds.reviewer }),
        ...(resolvedContextBlocks && { contextBlocks: resolvedContextBlocks }),
      });
      const durationMs = Date.now() - startedAtMs;

      // Auto-register a terminal context block for read-only routes
      // so callers can reference the output in subsequent dispatches (delta mode).
      // Uses the reviewer output (quality-gated) when available, falls back to implementer.
      let contextBlockId: string | null = null;
      const terminalContent = result.reviewerRaw ?? result.implementerOutput;
      if (run.sandbox === 'read-only' && terminalContent.trim().length > 0) {
        try {
          const block = contextBlockStore.register(terminalContent);
          contextBlockId = block.id;
        } catch { /* best-effort — store may be at capacity */ }
      }

      const totalActualCostUSD = result.cost.implementerUsd + (result.cost.reviewerUsd ?? 0);

      // Compute main-model equivalent cost using the caller's declared main model
      // (from X-MMA-Main-Model header) — same computation as to-wire-record.ts
      const mainModelId = caller.mainModel ?? deps.config.agents[implTier]?.model ?? 'unknown';
      const mainCard = resolveRateCard(mainModelId);
      const totalUsage = {
        inputTokens: result.implementerTurn.usage.inputTokens + (result.reviewerTurn?.usage.inputTokens ?? 0),
        outputTokens: result.implementerTurn.usage.outputTokens + (result.reviewerTurn?.usage.outputTokens ?? 0),
        cachedReadTokens: result.implementerTurn.usage.cachedReadTokens + (result.reviewerTurn?.usage.cachedReadTokens ?? 0),
        cachedNonReadTokens: result.implementerTurn.usage.cachedNonReadTokens + (result.reviewerTurn?.usage.cachedNonReadTokens ?? 0),
      };
      const mainEquivalentUSD = mainCard ? priceTokens(totalUsage, mainCard) : null;
      const costDeltaVsMain = mainEquivalentUSD !== null ? mainEquivalentUSD - totalActualCostUSD : null;

      // Cancellation mapping: an aborted pipeline surfaces as status 'failed'
      // with failureReason 'aborted'. When OUR scope fired the abort, the
      // terminal state is `cancelled` — the caller asked for this outcome, it
      // is not a failure. A pipeline that finished despite a late cancel won
      // the race and keeps its real status (first writer wins).
      const wasCancelled = result.status === 'failed' && scope.signal.aborted;

      const resultObj = {
        task: {
          taskId,
          type: input.type,
          ...(input.type === 'audit' && (input as Record<string, unknown>).subtype
            ? { subtype: (input as Record<string, unknown>).subtype }
            : {}),
          status: wasCancelled ? ('cancelled' as const) : result.status,
        },
        output: {
          // When the reviewer parsed cleanly, its refined structured output IS the answer.
          // When it didn't (reviewerOutput === null), fall straight to the implementer's
          // answer — never to result.reviewerTurn.output, which is the unparseable prose
          // that failed and would otherwise pollute summary.
          summary: result.reviewerOutput ?? tryParseJson(result.implementerOutput),
          filesChanged: result.worktree?.filesChanged ?? result.implementerTurn.filesWritten,
          contextBlockId,
          // Advisory: the reviewer ran but its output wasn't parseable, so the answer above
          // is the un-refined implementer output. This is a concern (status is already
          // done_with_concerns), NOT a fatal error — see the `error` field below.
          reviewerNote: result.reviewerParseError
            ? { code: 'reviewer_unavailable' as const, message: result.reviewerParseError }
            : null,
        },
        execution: {
          sessions: {
            implementer: result.sessions.implementer.sessionId,
            reviewer: result.sessions.reviewer?.sessionId ?? null,
          },
          worktree: result.worktree
            ? {
                merged: result.status !== 'failed',
                branch: result.worktree.branch,
                ...(result.status === 'failed' ? { path: result.worktree.path } : {}),
              }
            : null,
        },
        metrics: {
          totalDurationMs: durationMs,
          totalCostUsd: totalActualCostUSD,
          implementer: {
            durationMs: result.implementerTurn.durationMs,
            costUsd: result.cost.implementerUsd,
            usage: result.implementerTurn.usage,
          },
          reviewer: result.reviewerTurn ? {
            durationMs: result.reviewerTurn.durationMs,
            costUsd: result.cost.reviewerUsd!,
            usage: result.reviewerTurn.usage,
          } : null,
          totalUsage: totalUsage,
          mainEquivalentCostUsd: mainEquivalentUSD,
          savedVsMainCostUsd: costDeltaVsMain,
        },
        raw: {
          implementer: result.implementerOutput,
          reviewer: result.reviewerTurn?.output ?? null,
        },
        // Only a `failed` status is a fatal error. A reviewer that couldn't emit parseable
        // output is a concern, not a failure — the pipeline already downgraded it to
        // done_with_concerns and the implementer answer stands (surfaced in output.summary,
        // with the reason in output.reviewerNote). This mirrors the telemetry envelope's
        // structuredError, which is likewise null for done_with_concerns.
        error: result.status === 'failed'
          ? (result.failureReason ?? { code: 'pipeline_failed' as const, message: 'Pipeline completed with failed status' })
          : null,
      };

      // Emit telemetry via the bus — TelemetryUploader picks up the
      // sealed envelope snapshot and enqueues a wire record. A cancelled
      // execution rides as its raw pipeline status (wire schema v6 has no
      // cancelled state; the caller-initiated outcome lives in the task
      // envelope above, not the billing record).
      try {
        const implModelId = deps.config.agents[implTier]?.model ?? 'unknown';
        const revModelId = deps.config.agents[revTier]?.model ?? 'unknown';
        const envelope = buildEnvelopeSnapshot(
          taskId, input.type, result,
          implTier, revTier, reviewPolicy,
          implModelId, revModelId, mainModelId,
          caller.clientName,
          cwd, durationMs,
          pre.sourcesUsed ?? [],
        );
        deps.bus.emitEnvelopeSnapshot(envelope, 'seal');
      } catch (telErr) {
        process.stderr.write(
          `[mma] event=telemetry_emit_error ts=${new Date().toISOString()} task=${taskId} err="${(telErr instanceof Error ? telErr.message : String(telErr)).replace(/"/g, '\\"')}"\n`,
        );
      }

      if (wasCancelled) {
        finishCancelled(durationMs, resultObj);
      } else if (result.status === 'failed') {
        deps.taskRegistry.fail(taskId, resultObj);
        deps.store.fail(taskId, JSON.stringify(resultObj));
        deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_failed', fields: { task_id: taskId, tool: input.type, duration_ms: durationMs, error_code: result.failureReason?.code ?? 'pipeline_failed', error_message: result.failureReason?.message ?? 'Pipeline completed with failed status' } });
        process.stderr.write(
          `[mma] event=task_failed ts=${new Date().toISOString()} task=${taskId} route=${input.type} duration_ms=${durationMs}\n`,
        );
      } else {
        deps.taskRegistry.complete(taskId, resultObj);
        deps.store.complete(taskId, JSON.stringify(resultObj));
        deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_completed', fields: { task_id: taskId, tool: input.type, duration_ms: durationMs } });
        process.stderr.write(
          `[mma] event=task_completed ts=${new Date().toISOString()} task=${taskId} route=${input.type} duration_ms=${durationMs}\n`,
        );
      }
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      if (scope.signal.aborted) {
        // The abort raced an in-flight operation into an exception — the
        // caller's cancel is the real outcome, not a runner crash.
        finishCancelled(durationMs, buildErrorEnvelope(taskId, input.type, { code: 'aborted', message: 'Execution cancelled by caller' }, 'cancelled'));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      const errObj = {
        code: 'runner_crash',
        message,
        ...(stack !== undefined && { stack }),
      };
      const envelope = buildErrorEnvelope(taskId, input.type, errObj);
      deps.taskRegistry.fail(taskId, envelope);
      deps.store.fail(taskId, JSON.stringify(envelope));
      deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_failed', fields: { task_id: taskId, tool: input.type, duration_ms: durationMs, error_code: errObj.code, error_message: errObj.message } });
      process.stderr.write(
        `[mma] event=task_failed ts=${new Date().toISOString()} task=${taskId} route=${input.type} duration_ms=${durationMs} error="${message.replace(/"/g, '\\"')}"\n`,
      );
    } finally {
      this.liveScopes.delete(taskId);
      await scope.drain();
    }
  }
}
