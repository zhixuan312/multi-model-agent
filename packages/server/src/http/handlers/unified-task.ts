import type { RawHandler } from '../types.js';
import type { HandlerDeps } from '../handler-deps.js';
import {
  taskInputSchema,
  getTypeConfig,
  oppositeAgent,
  loadSkill,
  resolveAgent,
  isTerminal,
} from '@zhixuan92/multi-model-agent-core';
import { sendJson, sendError } from '../errors.js';
import { asyncDispatch } from '../async-dispatch.js';
import { runTwoPhasePipeline } from '@zhixuan92/multi-model-agent-core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
// Navigate from packages/server/src/http/handlers/ → packages/core/src/skills/
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
      skills = await loadSkill(input.type, SKILLS_DIR);
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
    const { type, agentTier: _at, reviewPolicy: _rp, sessionIds: _si, contextBlockIds: _cbi, ...payload } = input;

    const { batchId, statusUrl } = asyncDispatch({
      tool: input.type,
      projectCwd: cwd,
      blockIds,
      batchRegistry: deps.batchRegistry,
      projectContext: pc,
      deps,
      caller: { client: ctx.callerClient, mainModel: ctx.mainModel },
      executor: async (_ctx, id): Promise<Record<string, unknown>> => {
        const result = await runTwoPhasePipeline({
          type: input.type,
          implementerSkill: skills.implement,
          reviewerSkill: skills.review,
          taskPayload: JSON.stringify(payload, null, 2),
          implementerProvider: implAgent.provider,
          reviewerProvider: revAgent.provider,
          reviewPolicy,
          cwd,
          sandboxPolicy: typeConfig.sandbox,
          worktreeEnabled: typeConfig.worktree,
          taskId: id,
        });
        return {
          headline: `${input.type}: ${result.status}`,
          results: [{
            taskId: id,
            type: input.type,
            status: result.status,
            report: result.reviewerOutput ?? { raw: result.implementerOutput },
            sessions: result.sessions,
            worktree: result.worktree,
            cost: result.cost,
            error: null,
          }],
          batchTimings: { wallClockMs: 0, sumOfTaskMs: 0, estimatedParallelSavingsMs: 0 },
          costSummary: {
            totalActualCostUSD: result.cost.implementerUsd + (result.cost.reviewerUsd ?? 0),
            totalCostDeltaVsMainUSD: 0,
          },
          structuredReport: {
            summary: result.reviewerRaw ?? result.implementerOutput,
            workerStatus: result.status,
            filesChanged: result.implementerTurn.filesWritten,
          },
          error: result.status === 'failed'
            ? { code: 'pipeline_failed', message: 'Pipeline completed with failed status' }
            : { kind: 'not_applicable' as const, reason: 'task succeeded' },
        };
      },
    });

    sendJson(res, 202, { taskId: batchId, batchId, statusUrl });
  };
}

export function buildTaskPollHandler(deps: HandlerDeps): RawHandler {
  return async (_req, res, params, _ctx) => {
    const taskId = params.taskId;
    if (!taskId) {
      sendError(res, 400, 'missing_task_id', 'taskId required');
      return;
    }

    const entry = deps.batchRegistry.get(taskId);
    if (!entry) {
      sendError(res, 404, 'not_found', `Task ${taskId} not found`);
      return;
    }

    if (isTerminal(entry.state)) {
      sendJson(res, 200, entry.result ?? { taskId, status: entry.state, error: entry.error ?? null });
    } else {
      res.writeHead(202, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(entry.runningHeadlineSnapshot?.prefix || 'Running...');
    }
  };
}
