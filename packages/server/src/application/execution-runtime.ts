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
import type { ProjectRegistry } from './project-registry.js';
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
}

export type SubmitError =
  | { kind: 'agent_not_configured'; message: string }
  | { kind: 'skill_load_failed'; message: string }
  | { kind: 'project_reservation'; code: string; message: string };

export type SubmitResult =
  | { ok: true; taskId: string }
  | { ok: false; error: SubmitError };

export class ExecutionRuntime {
  constructor(private readonly deps: ExecutionRuntimeDeps) {}

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

    let implAgent: ResolvedAgent, revAgent: ResolvedAgent;
    try {
      implAgent = resolveAgent(implTier, deps.config);
      revAgent = resolveAgent(revTier, deps.config);
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

    // Register task in TaskRegistry; the adapter responds 202 immediately.
    const taskId = randomUUID();
    deps.taskRegistry.register(taskId, cwd, input.type);

    // Emit task-created diagnostic for observability.
    deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_created', fields: { batch_id: taskId, route: input.type } });

    // Run the pipeline asynchronously via setImmediate.
    const startedAtMs = Date.now();
    setImmediate(() => {
      void this.execute({
        taskId, input, caller, cwd, pc, skills,
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
      taskId, input, caller, cwd, pc, implAgent, revAgent,
      implTier, revTier, reviewPolicy, callerForcedReview, startedAtMs,
    } = run;
    let { skills } = run;
    const contextBlockStore = pc.contextBlocks;
    const sessionIds = (input as Record<string, unknown>).sessionIds as { implementer?: string; reviewer?: string } | undefined;
    const { type: _type, agentTier: _tier, reviewPolicy: _review, sessionIds: _sessions, contextBlockIds: _blocks, ...payload } = input as Record<string, unknown>;

    try {
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
            config: deps.config,
            implementerProvider: implAgent.provider,
          });
        } catch (err) {
          if (err instanceof PreprocessFailure) {
            deps.taskRegistry.fail(taskId, buildErrorEnvelope(taskId, input.type, { code: err.code, message: err.message }));
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
      const pinnedIds: string[] = [];
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
          pinnedIds.push(id);
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

      // Unpin context blocks now that the pipeline is done
      for (const id of pinnedIds) contextBlockStore.unpin(id);

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

      const resultObj = {
        task: {
          taskId,
          type: input.type,
          ...(input.type === 'audit' && (input as Record<string, unknown>).subtype
            ? { subtype: (input as Record<string, unknown>).subtype }
            : {}),
          status: result.status,
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
      // sealed envelope snapshot and enqueues a wire record.
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

      if (result.status === 'failed') {
        deps.taskRegistry.fail(taskId, resultObj);
        deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_failed', fields: { task_id: taskId, tool: input.type, duration_ms: durationMs, error_code: result.failureReason?.code ?? 'pipeline_failed', error_message: result.failureReason?.message ?? 'Pipeline completed with failed status' } });
        process.stderr.write(
          `[mma] event=task_failed ts=${new Date().toISOString()} task=${taskId} route=${input.type} duration_ms=${durationMs}\n`,
        );
      } else {
        deps.taskRegistry.complete(taskId, resultObj);
        deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_completed', fields: { task_id: taskId, tool: input.type, duration_ms: durationMs } });
        process.stderr.write(
          `[mma] event=task_completed ts=${new Date().toISOString()} task=${taskId} route=${input.type} duration_ms=${durationMs}\n`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      const errObj = {
        code: 'runner_crash',
        message,
        ...(stack !== undefined && { stack }),
      };
      deps.taskRegistry.fail(taskId, buildErrorEnvelope(taskId, input.type, errObj));
      const durationMs = Date.now() - startedAtMs;
      deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_failed', fields: { task_id: taskId, tool: input.type, duration_ms: durationMs, error_code: errObj.code, error_message: errObj.message } });
      process.stderr.write(
        `[mma] event=task_failed ts=${new Date().toISOString()} task=${taskId} route=${input.type} duration_ms=${durationMs} error="${message.replace(/"/g, '\\"')}"\n`,
      );
    }
  }
}
