// packages/server/src/http/handlers/control/batch.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { sendError, sendJson } from '../../errors.js';
import type { RawHandler } from '../../types.js';
import { notApplicable, type BatchRegistry, formatElapsed } from '@zhixuan92/multi-model-agent-core';
import type { TaskEnvelope, TaskEnvelopeStore } from '@zhixuan92/multi-model-agent-core/events/task-envelope';

export interface BatchHandlerDeps {
  batchRegistry: BatchRegistry;
}

// envelopeToPublicResult converts a TaskEnvelope to the public-safe per-task result shape.
function envelopeToPublicResult(env: TaskEnvelope) {
  return {
    taskId: env.taskId, taskIndex: env.taskIndex, route: env.route, agentType: env.agentType,
    status: env.status, terminalAt: env.terminalAt, stopReason: env.stopReason,
    stages: env.stages, // already PII-safe (counts/numerics/enums)
    totals: {
      costUSD: env.totalCostUSD, durationMs: env.totalDurationMs, turnsUsed: env.turnsUsed,
      inputTokens: env.totalInputTokens, outputTokens: env.totalOutputTokens,
    },
    findings: env.findings.map((f: any) => ({ id: f.id, severity: f.severity, category: f.category, claim: f.claim, source: f.source })),
    filesChangedCount: env.realFilesChanged.length,
    error: env.structuredError ? { code: (env.structuredError as any).code, message: (env.structuredError as any).message } : null,
    escalationSummary: { count: env.escalationLog.length, distinctProviders: new Set(env.escalationLog.map((e: any) => (e.toModel ?? ''))).size },
  };
}

// buildPendingHeadline constructs a pending batch headline from running envelope snapshots.
function buildPendingHeadline(entry: { taskEnvelopes?: (TaskEnvelopeStore | null)[]; tasksTotal?: number }): string {
  const running = (entry.taskEnvelopes ?? []).filter((e): e is TaskEnvelopeStore => e !== null && e.snapshot().status === 'running');
  if (running.length === 0) return `[0/${entry.tasksTotal ?? 1}] queued`;
  const rep = running[0];
  const repSnap = rep.snapshot();
  const summed = running.reduce((acc, e) => {
    const s = e.snapshot().headline;
    return { reads: acc.reads + s.toolReads, writes: acc.writes + s.toolWrites, total: acc.total + s.toolTotal };
  }, { reads: 0, writes: 0, total: 0 });
  const suffix = running.length > 1 ? ` +${running.length - 1}` : '';
  const stats = `reads=${summed.reads} writes=${summed.writes} tools=${summed.total}`;
  return `[${repSnap.headline.stageDone}/${repSnap.headline.stageTotal}] ${repSnap.headline.stageLabel}${suffix} — ${stats}`;
}

/**
 * GET /batch/:batchId — poll a batch.
 *
 * Status split (Theme 7):
 *  - pending                → 202 text/plain — body is the runningHeadline
 *  - complete/failed/expired → 200 JSON uniform 7-field envelope
 *
 * Optional ?taskIndex=N slices `results` on a complete envelope.
 *
 * Errors:
 *  unknown batchId         → 404 not_found
 *  non-numeric taskIndex   → 400 invalid_task_index
 *  taskIndex ≥ results.len → 404 unknown_task_index
 */
export function buildBatchHandler(deps: BatchHandlerDeps): RawHandler {
  return async (
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    ctx,
  ) => {
    const { batchId } = params;

    const entry = deps.batchRegistry.get(batchId);
    if (!entry) {
      sendError(res, 404, 'not_found', `Batch ${batchId} not found`);
      return;
    }

    // Parse optional taskIndex BEFORE checking batch state — syntactic
    // validation is independent of state, and clients shouldn't get a 202
    // when the request URL itself is malformed.
    const rawTaskIndex = ctx.url.searchParams.get('taskIndex');
    let taskIndex: number | null = null;
    if (rawTaskIndex !== null) {
      if (!/^\d+$/.test(rawTaskIndex)) {
        sendError(
          res,
          400,
          'invalid_task_index',
          `taskIndex must be a non-negative integer; got: ${JSON.stringify(rawTaskIndex)}`,
        );
        return;
      }
      taskIndex = parseInt(rawTaskIndex, 10);
    }

    // Pending → 202 text/plain progress line.
    // ALWAYS one line, regardless of single-task or batch. For batches, the
    // line aggregates per-task state: slowest running task is the headline's
    // representative (largest elapsed = oldest dispatchedAt, ties broken by
    // lowest taskIndex), counts are summed across all started tasks, and a
    // " +K" suffix marks how many other tasks are running concurrently.
    // Final shape (identical for N=1 and N>1):
    //   [X/Y] Implementing by Standard worker (1/9)[+K] - 6m 0s, 142 read, 8 write, 234 tool calls
    if (entry.state === 'pending') {
      let headline: string;

      // Try envelope-based path first if envelopes are available
      if (entry.taskEnvelopes && entry.taskEnvelopes.length > 0) {
        headline = buildPendingHeadline(entry);
      } else {
        const perTask = entry.perTaskHeadlineSnapshots;
        // tasksTotal is set by async-dispatch to a placeholder (1) before the
        // executor knows the real fan-out size; perTask.size reflects actual
        // tasks that have started, so prefer the larger of the two.
        const totalTasks = Math.max(entry.tasksTotal ?? 1, perTask?.size ?? 0);
        if (perTask && perTask.size > 0) {
        const sortedIndices = [...perTask.keys()].sort((a, b) => a - b);
        // Slowest = oldest dispatchedAt (i.e., largest elapsed). Stable
        // tie-break on lowest taskIndex (sortedIndices is already ascending).
        let slowestIdx = sortedIndices[0];
        let slowest = perTask.get(slowestIdx)!;
        for (const idx of sortedIndices) {
          const snap = perTask.get(idx)!;
          if (snap.dispatchedAt < slowest.dispatchedAt) {
            slowest = snap;
            slowestIdx = idx;
          }
        }
        // Sum counts across all started tasks for the aggregate stats clause.
        let sumRead = 0;
        let sumWrite = 0;
        let sumTotal = 0;
        let haveStructuredCounts = false;
        for (const idx of sortedIndices) {
          const snap = perTask.get(idx)!;
          if (
            typeof snap.toolReads === 'number' ||
            typeof snap.toolWrites === 'number' ||
            typeof snap.toolTotal === 'number'
          ) {
            haveStructuredCounts = true;
            sumRead += snap.toolReads ?? 0;
            sumWrite += snap.toolWrites ?? 0;
            sumTotal += snap.toolTotal ?? 0;
          }
        }
          const startedCount = perTask.size;
          const taskBracket = `[${startedCount}/${totalTasks}]`;
          const runningSuffix = startedCount > 1 ? ` +${startedCount - 1}` : '';
          const elapsedMs = Date.now() - slowest.dispatchedAt;
          if (haveStructuredCounts && slowest.stageLabel) {
            const tierClause = slowest.tier ? ` by ${slowest.tier} worker` : '';
            const stageProgressClause =
              typeof slowest.stageDone === 'number' && typeof slowest.stageTotal === 'number'
                ? ` (${slowest.stageDone}/${slowest.stageTotal})`
                : '';
            const statsClause = `, ${sumRead} read, ${sumWrite} write, ${sumTotal} tool calls`;
            headline = `${taskBracket} ${slowest.stageLabel}${tierClause}${stageProgressClause}${runningSuffix} - ${formatElapsed(elapsedMs)}${statsClause}`;
          } else if (slowest.prefix) {
            // Older snapshot path: inject the +K suffix before the prefix's " - "
            // separator if needed.
            const prefixWithSuffix = runningSuffix
              ? slowest.prefix.replace(/ - $/, `${runningSuffix} - `)
              : slowest.prefix;
            headline = `${taskBracket} ${prefixWithSuffix}${formatElapsed(elapsedMs)}${slowest.statsClause}`;
          } else {
            headline = `${taskBracket} ${slowest.fallback}${runningSuffix}`;
          }
        } else {
          const snap = entry.runningHeadlineSnapshot;
          if (!snap) {
            headline = '[0/0] queued';
          } else {
            const elapsedMs = Date.now() - snap.dispatchedAt;
            headline = snap.prefix
              ? `${snap.prefix}${formatElapsed(elapsedMs)}${snap.statsClause}`
              : snap.fallback;
          }
        }

        // Group-aware suffix (4.6.0+): only applies when this batch was dispatched
        // via serializeSameRepo and the dispatcher attached group metadata.
        if (entry.groups && entry.groups.length > 0) {
          const perTask = entry.perTaskHeadlineSnapshots;
          type GroupRunning = { groupIdx: number; earliestDispatchedAt: number; inflightInGroup: number };
          const runningByGroup: GroupRunning[] = [];
          let totalInflight = 0;
          entry.groups.forEach((g, gi) => {
            let earliest = Infinity;
            let inflight = 0;
            for (const ti of g.taskIndices) {
              const snap = perTask?.get(ti);
              if (!snap) continue;
              // Convention: presence of a snapshot on a pending batch === in-flight.
              inflight++;
              totalInflight++;
              if (snap.dispatchedAt < earliest) earliest = snap.dispatchedAt;
            }
            if (inflight > 0) {
              runningByGroup.push({ groupIdx: gi, earliestDispatchedAt: earliest, inflightInGroup: inflight });
            }
          });
          // Pick leader by earliest dispatchedAt; ties break to smaller groupIdx.
          runningByGroup.sort((a, b) =>
            a.earliestDispatchedAt - b.earliestDispatchedAt || a.groupIdx - b.groupIdx,
          );
          const leader = runningByGroup[0];

          if (entry.groups.length === 1) {
            // Single-group batch: append (sequential); strip any +K suffix
            // because there's never a concurrent sibling in a single group.
            headline = headline.replace(/ \+\d+/, '') + ' (sequential)';
          } else if (leader) {
            // Multi-group batch: insert (group X/Y, sequential) before the
            // " - <elapsed>" tail. +K now reflects only OTHER-group inflight.
            const otherInflight = totalInflight - leader.inflightInGroup;
            const groupSuffix = ` (group ${leader.groupIdx + 1}/${entry.groups.length}, sequential)`;
            headline = headline.replace(/ \+\d+/, '');
            if (otherInflight > 0) {
              headline = headline.replace(/( - )/, `${groupSuffix} +${otherInflight}$1`);
            } else {
              headline = headline.replace(/( - )/, `${groupSuffix}$1`);
            }
          } else if (entry.groups.length > 1) {
            // Multi-group batch with no in-flight task yet (pre-dispatch race
            // window): still annotate so the user knows grouping is in play.
            headline += ` (groups: ${entry.groups.length}, sequential)`;
          }
        }
      }

      res.writeHead(202, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(headline);
      return;
    }

    // Build terminal response from envelopes if available, otherwise use pre-computed result
    let fullResult: Record<string, unknown> | undefined;

    if (entry.taskEnvelopes && entry.taskEnvelopes.length > 0) {
      // Build response from envelope snapshots
      const snapshots = entry.taskEnvelopes
        .map(e => e?.snapshot())
        .filter((snap): snap is TaskEnvelope => snap !== undefined && snap !== null);

      if (snapshots.length > 0) {
        // Build results array from envelopes
        const results = snapshots.map((env: TaskEnvelope) => envelopeToPublicResult(env));

        // Derive batchTimings from envelopes
        const allStartedAt = snapshots.map(s => new Date(s.startedAt).getTime());
        const allTerminalAt = snapshots.map(s => (s.terminalAt ? new Date(s.terminalAt).getTime() : 0));
        const batchStart = Math.min(...allStartedAt);
        const batchEnd = Math.max(...allTerminalAt.filter(t => t > 0));
        const sumDurations = snapshots.reduce((sum, s) => sum + s.totalDurationMs, 0);

        const batchTimings = {
          wallClockMs: batchEnd - batchStart,
          sumOfTaskMs: sumDurations,
          estimatedParallelSavingsMs: Math.max(0, sumDurations - (batchEnd - batchStart)),
        };

        // Derive costSummary from envelopes
        const costSummary = {
          totalActualCostUSD: snapshots.reduce((sum, s) => sum + s.totalCostUSD, 0),
          totalCostDeltaVsMainUSD: 0, // Not available from envelopes
        };

        // Derive structuredReport from findings
        const allFindings = snapshots.flatMap(s => s.findings);
        const structuredReport = {
          summary: allFindings.length > 0 ? `${allFindings.length} finding(s)` : 'No findings',
          workerStatus: snapshots.length > 0 ? snapshots[0].status : 'unknown',
          unresolved: [] as unknown[],
          filesChanged: snapshots.flatMap(s => s.realFilesChanged),
          reviewVerdict: null,
          reviewConcerns: [] as unknown[],
          reworkApplied: false,
          validationsRun: [] as unknown[],
          commitSha: null,
          commitMessage: null,
          commitSkipReason: null,
          findings: allFindings.map(f => ({ severity: f.severity, category: f.category, claim: f.claim })),
          criteriaErrors: [] as unknown[],
        };

        // Build headline
        const headline = `${entry.tool}: ${snapshots.length} task(s) complete`;

        // Build error from first failed envelope if any
        const firstError = snapshots.find(s => s.structuredError);
        const error = firstError?.structuredError
          ? { code: firstError.structuredError.code, message: firstError.structuredError.message }
          : { kind: 'not_applicable' as const, reason: 'batch succeeded' };

        fullResult = { headline, results, batchTimings, costSummary, structuredReport, error };
      }
    }

    // Fall back to pre-computed result if not built from envelopes
    if (!fullResult) {
      fullResult = entry.result as Record<string, unknown> | undefined;
    }

    if (entry.state === 'failed' || entry.state === 'expired' || !fullResult) {
      const reason = `batch ${entry.state}`;
      const errPayload = entry.error ?? (fullResult && fullResult['error']) ?? notApplicable('batch succeeded');
      sendJson(res, 200, {
        headline:
          entry.state === 'expired'
            ? 'batch expired'
            : entry.state === 'failed'
              ? 'batch failed'
              : (fullResult?.['headline'] as string | undefined) ?? `batch ${entry.state}`,
        results: (fullResult?.['results'] as unknown) ?? notApplicable(reason),
        batchTimings: (fullResult?.['batchTimings'] as unknown) ?? notApplicable(reason),
        costSummary: (fullResult?.['costSummary'] as unknown) ?? notApplicable(reason),
        structuredReport: (fullResult?.['structuredReport'] as unknown) ?? notApplicable(reason),
        error: errPayload,
      });
      return;
    }

    // entry.state === 'complete' with a stored result. Executor emits all 7 fields.
    if (taskIndex !== null) {
      const results = fullResult['results'];
      if (!Array.isArray(results) || taskIndex >= results.length) {
        sendError(
          res,
          404,
          'unknown_task_index',
          `taskIndex ${taskIndex} is out of range (batch has ${Array.isArray(results) ? results.length : 0} result(s))`,
        );
        return;
      }
      sendJson(res, 200, { ...fullResult, results: [results[taskIndex]] });
      return;
    }

    sendJson(res, 200, fullResult);
  };
}
