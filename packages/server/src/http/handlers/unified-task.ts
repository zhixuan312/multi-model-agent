import { randomUUID } from 'node:crypto';
import type { RawHandler } from '../types.js';
import type { HandlerDeps } from '../handler-deps.js';
import {
  taskInputSchema,
  getTypeConfig,
  oppositeAgent,
  loadSkill,
  resolveAgent,
  runTwoPhasePipeline,
} from '@zhixuan92/multi-model-agent-core';
import type { PipelineResult, AgentType, TaskType } from '@zhixuan92/multi-model-agent-core';
import type { TaskEnvelope, StageRecord, Route } from '@zhixuan92/multi-model-agent-core/events/task-envelope';
import type { Provider } from '@zhixuan92/multi-model-agent-core';
import type { ResearchConfig } from '@zhixuan92/multi-model-agent-core/config/schema';
import {
  BraveClient,
  runOrchestrator,
  parseQueryPlan,
  serializeEvidencePack,
  summarizeSourcesUsed,
  resolveEnabledAdapters,
  arxivSearch,
  semanticScholarSearch,
  githubSearch,
} from '@zhixuan92/multi-model-agent-core/research';
import type { EvidencePack, SourceUsage } from '@zhixuan92/multi-model-agent-core/research';
import { sendJson, sendError } from '../errors.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Map unified TaskType (underscores) to wire Route (hyphens). */
function taskTypeToRoute(type: TaskType): Route {
  const map: Record<string, Route> = {
    execute_plan: 'execute-plan',
    journal_recall: 'journal-recall',
    journal_record: 'journal-record',
    retry_tasks: 'retry',
  };
  return (map[type] ?? type) as Route;
}

/**
 * Build a goal condition string for the Stop hook. This keeps the agent
 * working until it has covered all criteria defined in the skill file.
 */
function buildGoalCondition(type: TaskType, role: 'implementer' | 'reviewer', skillContent: string): string | undefined {
  if (role === 'reviewer') {
    return [
      'You have verified every criterion the implementer was supposed to cover.',
      'You have checked for hallucinated findings (claims without evidence in the source material).',
      'You have validated evidence quality (every finding cites actual file:line or quoted text).',
      'You have checked severity calibration against the skill definitions.',
      'You have produced the required JSON output block with findings, summary, and verdict.',
    ].join(' ');
  }

  switch (type) {
    case 'audit': {
      const countMatch = skillContent.match(/(\d+)\s+(?:Verification Criteria|perspectives|failure modes|Execution Steps)/i);
      const count = countMatch ? countMatch[1] : 'all';
      return [
        `You have evaluated the document against ALL ${count} criteria one by one.`,
        'For each criterion, you wrote findings to the scratch file before moving to the next.',
        'Every criterion either has findings with quoted evidence, or an explicit "No findings for this criterion." entry.',
        'You have read the scratch file and consolidated into the final JSON output block.',
        `The criteriaCovered array in your output lists all ${count} criteria.`,
      ].join(' ');
    }
    case 'investigate':
      return [
        'You have applied ALL 5 investigation perspectives: direct-symbol-trace, caller-analysis, test-driven, cross-file dependency-map, documentation/comment-lens.',
        'Every finding cites file:line from files you actually read (no training-data citations).',
        'Absent things are evidenced with "searched <pattern> in <path>, no matches."',
        'You have calibrated confidence (high/medium/low) based on evidence strength.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'review':
      return [
        'You have swept ALL 10 review categories: test gap, cross-file ripple, pre-existing-vs-regression, missing edge case, race/concurrency, resource leak, backward-compat break, security regression, performance regression, implicit-contract assumption.',
        'Cross-file findings cite both the change site AND the broken caller.',
        'Pre-existing bugs are separated from new regressions.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'debug':
      return [
        'You have applied ALL 4 investigation angles: symptom-location, recent-change, test-failure, reproduction.',
        'Your trace chain has at least 3 evidence points: symptom → intermediate state → cause, each with file:line.',
        'You have proposed a fix (read-only — describe, do not apply).',
        'You have stated a falsifier (how the maintainer verifies the fix).',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'research':
      return [
        'You have searched from ALL 5 perspectives: primary-sources, practitioner-consensus, recent-developments, counter-perspectives, cross-domain.',
        'Every finding cites a real source with URL or identifier.',
        'Source tier (primary/practitioner/recent) is indicated.',
        'You have produced the required JSON output block with sources, findings, and synthesis.',
      ].join(' ');
    case 'delegate':
      return [
        'You have implemented ALL requested changes in the task description.',
        'Only the declared filePaths were modified (no scope creep).',
        'If tests exist for the changed area, you have verified they pass.',
        'You have produced the required JSON output block listing tasks completed and files changed.',
      ].join(' ');
    case 'execute_plan':
      return [
        'You have followed EVERY step in the plan exactly as written.',
        'Code blocks in the plan were applied verbatim (no substitution or improvisation).',
        'If the plan lists verification commands, you ran them.',
        'No steps were skipped or reordered.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'journal_record':
      return [
        'You have classified the learning (decision/constraint/pattern/mistake).',
        'You have checked the existing journal for supersede/refine/merge candidates.',
        'You have written the node file with proper YAML frontmatter and edges.',
        'You have updated the journal catalog (log.md and index.md).',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'journal_recall':
      return [
        'You have searched from ALL 3 perspectives: keyword-match, graph-neighborhood, contradiction-and-history.',
        'Superseded nodes are excluded from results.',
        'Each result includes the learning, context, and relevance assessment.',
        'You have produced the required JSON output block.',
      ].join(' ');
    default:
      return 'You have completed the task as specified in the skill instructions and produced the required output.';
  }
}

/**
 * Build a minimal TaskEnvelope-compatible snapshot from a PipelineResult
 * so the TelemetryUploader can convert it to a wire record and enqueue it.
 */
function buildEnvelopeSnapshot(
  taskId: string,
  type: TaskType,
  result: PipelineResult,
  implTier: AgentType,
  revTier: AgentType,
  reviewPolicy: 'reviewed' | 'none',
  implModel: string,
  revModel: string,
  mainModel: string,
  cwd: string,
  durationMs: number,
  sourcesUsed: TaskEnvelope['sourcesUsed'] = [],
): TaskEnvelope {
  const now = new Date().toISOString();
  const route = taskTypeToRoute(type);

  // Build stage records from the pipeline turns.
  const stages: StageRecord[] = [];
  const implTurn = result.implementerTurn;
  stages.push({
    name: 'implementing',
    round: 1,
    outcome: result.status === 'failed' ? 'fail' : 'advance',
    startedAt: now,
    completedAt: now,
    durationMs: implTurn.durationMs,
    costUSD: implTurn.costUSD,
    model: implModel,
    tier: implTier,
    turnsUsed: implTurn.turns,
    filesWrittenCount: implTurn.filesWritten.length,
    inputTokens: implTurn.usage.inputTokens,
    outputTokens: implTurn.usage.outputTokens,
    cachedReadTokens: implTurn.usage.cachedReadTokens,
    cachedNonReadTokens: implTurn.usage.cachedNonReadTokens,
  });

  if (result.reviewerTurn) {
    const revTurn = result.reviewerTurn;
    stages.push({
      name: 'reviewing',
      round: 1,
      outcome: result.status === 'done_with_concerns' ? 'concern' : 'advance',
      startedAt: now,
      completedAt: now,
      durationMs: revTurn.durationMs,
      costUSD: revTurn.costUSD,
      model: revModel,
      tier: revTier,
      turnsUsed: revTurn.turns,
      filesWrittenCount: 0,
      inputTokens: revTurn.usage.inputTokens,
      outputTokens: revTurn.usage.outputTokens,
      cachedReadTokens: revTurn.usage.cachedReadTokens,
      cachedNonReadTokens: revTurn.usage.cachedNonReadTokens,
      verdict: result.status === 'done_with_concerns' ? 'concerns' : 'approved',
      concernCategories: [],
    });
  }

  const totalInputTokens = stages.reduce((s, st) => s + st.inputTokens, 0);
  const totalOutputTokens = stages.reduce((s, st) => s + st.outputTokens, 0);
  const totalCachedRead = stages.reduce((s, st) => s + (st.cachedReadTokens ?? 0), 0);
  const totalCachedNonRead = stages.reduce((s, st) => s + (st.cachedNonReadTokens ?? 0), 0);
  const totalCostUSD = stages.reduce((s, st) => s + (st.costUSD ?? 0), 0);

  return {
    taskId,
    batchId: taskId,
    taskIndex: 0,
    route,
    agentType: implTier,
    client: 'claude-code',
    mainModel,
    cwd,
    startedAt: now,
    status: result.status,
    terminalAt: now,
    stopReason: null,
    structuredError: result.status === 'failed'
      ? { code: 'pipeline_failed', message: 'Pipeline completed with failed status' }
      : null,
    errorCode: null,
    reviewPolicy: reviewPolicy === 'none' ? 'none' : 'reviewed',
    plannedStageTotal: stages.length,
    stages,
    toolCalls: [],
    filesWritten: implTurn.filesWritten,
    realFilesChanged: implTurn.filesWritten,
    commitSha: null,
    commitMessage: null,
    commitSkipReason: null,
    contextBlockId: null,
    totalCostUSD,
    totalInputTokens,
    totalOutputTokens,
    totalCachedReadTokens: totalCachedRead,
    totalCachedNonReadTokens: totalCachedNonRead,
    totalDurationMs: durationMs,
    turnsUsed: stages.reduce((s, st) => s + st.turnsUsed, 0),
    stallCount: 0,
    sandboxViolationCount: 0,
    taskMaxIdleMs: 0,
    findings: [],
    sourcesUsed,
    escalationLog: [],
    validationWarnings: [],
    headline: { prefix: '', stageLabel: 'done', stageIndex: stages.length, stageTotal: stages.length, toolWrites: 0, toolTotal: 0 },
  };
}

// ─── Research pre-processing ─────────────────────────────────────────────

interface ResearchContext {
  /** Serialized evidence pack to inject into the implementer prompt. */
  evidenceMarkdown: string;
  /** Structured source-usage summary for the response envelope. */
  sourcesUsed: SourceUsage[];
}

const QUERY_PLAN_PROMPT = `You are a research query planner. Given a research question and background, emit ONLY a JSON query plan — no prose, no code fences.

The JSON must conform to this shape:
{
  "braveQueries":           ["<search query string>", ...],
  "arxivQueries":           ["<search query string>", ...],
  "semanticScholarQueries": ["<search query string>", ...],
  "githubQueries":          [{"q": "<search query string>", "kind": "repo|code"}, ...]
}

Rules:
- Max 8 entries per array, max 200 chars per query string.
- Phrase queries as topical keywords, NOT full sentences.
- Empty arrays are allowed for sources you do not need.
- Emit ONLY the JSON object.`;

/**
 * Turn 1 + orchestrator: ask the implementer LLM for a QueryPlan, then fan
 * out across real adapters to gather an EvidencePack. Falls back gracefully:
 * - If the LLM output isn't parseable as a QueryPlan, returns null (caller
 *   proceeds with LLM-only research).
 * - If the orchestrator throws, returns null.
 */
async function prepareResearchContext(
  researchQuestion: string,
  background: string,
  implProvider: Provider,
  researchCfg: ResearchConfig,
  taskId: string,
  cwd: string,
): Promise<ResearchContext | null> {
  // --- Turn 1: generate a query plan via the implementer LLM ---
  const planSession = implProvider.openSession({
    cwd,
    wallClockDeadline: Date.now() + 60_000,  // 60s budget for plan generation
    abortSignal: new AbortController().signal,
    taskId,
    taskIndex: 0,
  });

  try {
    const planPrompt = [
      QUERY_PLAN_PROMPT,
      '',
      '## Research Question',
      researchQuestion,
      '',
      '## Background',
      background,
    ].join('\n');

    const planTurn = await planSession.send(planPrompt);
    const planOutput = planTurn.output.trim();

    // Extract JSON from the output — the LLM may wrap it in code fences
    let jsonStr = planOutput;
    const fenceMatch = planOutput.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1]!.trim();
    }

    const queryPlan = parseQueryPlan(jsonStr);

    // --- Orchestrator: fan out queries against real APIs ---
    const enabledAdapters = resolveEnabledAdapters(researchCfg.builtinAdapters, {
      semanticScholarApiKey: researchCfg.builtinAdapters.semanticScholarApiKey,
      githubPat: researchCfg.builtinAdapters.githubPat,
    });

    // Build BraveClient only if API keys are configured
    const hasBraveKeys = researchCfg.brave.apiKeys.length > 0;
    const braveClient = hasBraveKeys ? new BraveClient(researchCfg.brave) : null;

    const pack = await runOrchestrator(queryPlan, {
      enabledAdapters,
      brave: {
        search: async (query: string) => {
          if (!braveClient) {
            throw new Error('brave_not_configured: no API keys');
          }
          return braveClient.search(query);
        },
      },
      adapters: {
        arxiv: (q) => arxivSearch(q),
        semanticScholar: (q) => semanticScholarSearch(q, {
          apiKey: researchCfg.builtinAdapters.semanticScholarApiKey,
        }),
        github: (q, kind) => githubSearch(q, {
          kind,
          pat: researchCfg.builtinAdapters.githubPat,
        }),
      },
      perAdapterTimeoutMs: researchCfg.brave.timeoutMs,
      totalDeadlineMs:     30_000,
      concurrencyCap:      4,
    });

    const evidenceMarkdown = serializeEvidencePack(pack);
    const sourcesUsed = summarizeSourcesUsed(pack);

    process.stderr.write(
      `[mmagent] event=research_evidence_ready ts=${new Date().toISOString()} task=${taskId} sources=${pack.sources.length} failed=${pack.failedAttempts.length}\n`,
    );

    return { evidenceMarkdown, sourcesUsed };
  } catch (err) {
    process.stderr.write(
      `[mmagent] event=research_preprocess_failed ts=${new Date().toISOString()} task=${taskId} error="${((err instanceof Error ? err.message : String(err))).replace(/"/g, '\\"')}"\n`,
    );
    return null;
  } finally {
    try { await planSession.close(); } catch { /* best-effort */ }
  }
}

// ─── Handler helpers ─────────────────────────────────────────────────────

const thisDir = path.dirname(fileURLToPath(import.meta.url));
// Navigate from packages/server/src/http/handlers/ -> packages/core/src/skills/
// 5x .. walks up to the monorepo root; then packages/core/src/skills/ reaches the skill .md files.
const SKILLS_DIR = path.resolve(thisDir, '..', '..', '..', '..', '..', 'packages', 'core', 'src', 'skills');

export function buildUnifiedTaskHandler(deps: HandlerDeps): RawHandler {
  return async (_req, res, _params, ctx) => {
    const parsed = taskInputSchema.safeParse(ctx.body);
    if (!parsed.success) {
      sendError(res, 400, 'invalid_request', 'Validation failed', {
        fieldErrors: parsed.error.flatten(),
      });
      return;
    }

    const input = parsed.data;
    const cwd = ctx.cwd;
    if (!cwd) {
      sendError(res, 400, 'invalid_cwd', 'cwd query parameter required');
      return;
    }

    const typeConfig = getTypeConfig(input.type);
    const implTier = input.agentTier ?? typeConfig.defaultTier;
    const revTier = oppositeAgent(implTier);
    const reviewPolicy = input.reviewPolicy ?? 'reviewed';

    let implAgent, revAgent;
    try {
      implAgent = resolveAgent(implTier, deps.config);
      revAgent = resolveAgent(revTier, deps.config);
    } catch (err) {
      sendError(res, 503, 'agent_not_configured', err instanceof Error ? err.message : 'Agent resolution failed');
      return;
    }

    let skills;
    try {
      const subtype = (input as Record<string, unknown>).subtype as string | undefined;
      skills = await loadSkill(input.type, SKILLS_DIR, subtype);
    } catch (err) {
      sendError(res, 500, 'skill_load_failed', err instanceof Error ? err.message : 'Skill load failed');
      return;
    }

    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      sendError(res, 503, reserveResult.error, reserveResult.message);
      return;
    }
    const pc = reserveResult.projectContext;
    pc.lastActivityAt = Date.now();
    deps.projectRegistry.cancelReservation(cwd);

    const blockIds = input.contextBlockIds ?? [];
    const contextBlockStore = pc.contextBlocks;
    const { type, agentTier: _at, reviewPolicy: _rp, sessionIds: _si, contextBlockIds: _cbi, ...payload } = input;

    // Register task in TaskRegistry and return 202 immediately
    const taskId = randomUUID();
    deps.taskRegistry.register(taskId, cwd, input.type);

    // Emit batch_created diagnostic for observability parity with the old lifecycle.
    deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_created', fields: { batch_id: taskId, route: input.type } });

    const statusUrl = `/task/${taskId}`;
    sendJson(res, 202, { taskId, statusUrl });

    // Run the pipeline asynchronously via setImmediate
    const startedAtMs = Date.now();
    setImmediate(() => {
      void (async () => {
        try {
          process.stderr.write(
            `[mmagent] event=executor_started ts=${new Date().toISOString()} task=${taskId} route=${input.type}\n`,
          );
          const implementerGoal = buildGoalCondition(input.type, 'implementer', skills.implement);
          const reviewerGoal = buildGoalCondition(input.type, 'reviewer', skills.review);

          // ── Research pre-processing: Turn 1 (query plan) + orchestrator ──
          let researchCtx: ResearchContext | null = null;
          let enrichedPayload = JSON.stringify(payload, null, 2);

          if (input.type === 'research') {
            const researchPayload = payload as { researchQuestion: string; background: string };
            researchCtx = await prepareResearchContext(
              researchPayload.researchQuestion,
              researchPayload.background,
              implAgent.provider,
              deps.config.research,
              taskId,
              cwd,
            );
            if (researchCtx) {
              // Inject the real evidence into the payload so the implementer
              // synthesizes from actual sources, not training-data recall.
              enrichedPayload = [
                enrichedPayload,
                '',
                '---',
                '',
                '## Pre-fetched Evidence (from real API queries)',
                '',
                researchCtx.evidenceMarkdown,
              ].join('\n');
            }
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
            sandboxPolicy: typeConfig.sandbox,
            worktreeEnabled: typeConfig.worktree,
            taskId,
            implementerGoal,
            reviewerGoal,
          });
          const durationMs = Date.now() - startedAtMs;

          // Auto-register a terminal context block for read-only routes
          // (investigate, audit, review, debug, research, journal_recall)
          // so callers can reference the output in subsequent dispatches.
          let contextBlockId: string | null = null;
          if (typeConfig.sandbox === 'read-only' && result.implementerOutput.trim().length > 0) {
            try {
              const block = contextBlockStore.register(result.implementerOutput);
              contextBlockId = block.id;
            } catch { /* best-effort — store may be at capacity */ }
          }

          const resultObj = {
            headline: `${input.type}: ${result.status}`,
            results: [{
              taskId,
              type: input.type,
              status: result.status,
              report: {
                implementer: result.implementerOutput,
                reviewer: result.reviewerOutput,
                reviewerParseError: result.reviewerParseError,
              },
              sessions: result.sessions,
              worktree: result.worktree,
              cost: result.cost,
              contextBlockId,
              error: null,
            }],
            taskTimings: { wallClockMs: durationMs, sumOfTaskMs: durationMs, estimatedParallelSavingsMs: 0 },
            costSummary: {
              totalActualCostUSD: result.cost.implementerUsd + (result.cost.reviewerUsd ?? 0),
              totalCostDeltaVsMainUSD: 0,
            },
            structuredReport: {
              summary: result.reviewerRaw ?? result.implementerOutput,
              workerStatus: result.status,
              filesChanged: result.implementerTurn.filesWritten,
            },
            sourcesUsed: researchCtx?.sourcesUsed ?? [],
            error: result.status === 'failed'
              ? { code: 'pipeline_failed', message: 'Pipeline completed with failed status' }
              : { kind: 'not_applicable' as const, reason: 'task succeeded' },
          };

          // Emit telemetry via the bus — TelemetryUploader picks up the
          // sealed envelope snapshot and enqueues a wire record.
          try {
            const implModelId = deps.config.agents[implTier]?.model ?? 'unknown';
            const revModelId = deps.config.agents[revTier]?.model ?? 'unknown';
            const mainModelId = deps.config.defaults?.mainModel ?? implModelId;
            const envelope = buildEnvelopeSnapshot(
              taskId, input.type, result,
              implTier, revTier, reviewPolicy,
              implModelId, revModelId, mainModelId,
              cwd, durationMs,
              researchCtx?.sourcesUsed ?? [],
            );
            deps.bus.emitEnvelopeSnapshot(envelope, 'seal');
          } catch (telErr) {
            process.stderr.write(
              `[mmagent] event=telemetry_emit_error ts=${new Date().toISOString()} task=${taskId} err="${(telErr instanceof Error ? telErr.message : String(telErr)).replace(/"/g, '\\"')}"\n`,
            );
          }

          if (result.status === 'failed') {
            deps.taskRegistry.fail(taskId, resultObj);
            deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_failed', fields: { task_id: taskId, tool: input.type, duration_ms: durationMs, error_code: 'pipeline_failed', error_message: 'Pipeline completed with failed status' } });
            process.stderr.write(
              `[mmagent] event=task_failed ts=${new Date().toISOString()} task=${taskId} route=${input.type} duration_ms=${durationMs}\n`,
            );
          } else {
            deps.taskRegistry.complete(taskId, resultObj);
            deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_completed', fields: { task_id: taskId, tool: input.type, duration_ms: durationMs } });
            process.stderr.write(
              `[mmagent] event=task_completed ts=${new Date().toISOString()} task=${taskId} route=${input.type} duration_ms=${durationMs}\n`,
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
          deps.taskRegistry.fail(taskId, errObj);
          const durationMs = Date.now() - startedAtMs;
          deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_failed', fields: { task_id: taskId, tool: input.type, duration_ms: durationMs, error_code: errObj.code, error_message: errObj.message } });
          process.stderr.write(
            `[mmagent] event=task_failed ts=${new Date().toISOString()} task=${taskId} route=${input.type} duration_ms=${durationMs} error="${message.replace(/"/g, '\\"')}"\n`,
          );
        }
      })();
    });
  };
}

export function buildTaskPollHandler(deps: HandlerDeps): RawHandler {
  return async (_req, res, params, _ctx) => {
    const taskId = params.taskId;
    if (!taskId) {
      sendError(res, 400, 'missing_task_id', 'taskId required');
      return;
    }

    const entry = deps.taskRegistry.get(taskId);
    if (!entry) {
      sendError(res, 404, 'not_found', `Task ${taskId} not found`);
      return;
    }

    if (deps.taskRegistry.isTerminal(taskId)) {
      sendJson(res, 200, entry.result ?? { taskId, status: entry.state, error: null });
    } else {
      res.writeHead(202, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(entry.runningHeadline || 'Running...');
    }
  };
}
