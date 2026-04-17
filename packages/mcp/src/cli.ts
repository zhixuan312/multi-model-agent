#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfigFromFile } from '@zhixuan92/multi-model-agent-core/config/load';
import { parseConfig } from '@zhixuan92/multi-model-agent-core/config/schema';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import { InMemoryContextBlockStore } from '@zhixuan92/multi-model-agent-core';
import type {
  MultiModelConfig,
  TaskSpec,
  ProgressEvent,
  RunResult,
  BatchTimings,
  BatchProgress,
  BatchAggregateCost,
  AgentCapability,
} from '@zhixuan92/multi-model-agent-core';
import { renderProviderRoutingMatrix } from './routing/render-provider-routing-matrix.js';
import { composeHeadline } from './headline.js';
import {
  computeTimings,
  computeBatchProgress,
  computeAggregateCost,
} from './tools/batch-response.js';
import { registerAuditDocument } from './tools/audit-document.js';
import { registerDebugTask } from './tools/debug-task.js';
import { registerReviewCode } from './tools/review-code.js';
import { registerVerifyWork } from './tools/verify-work.js';
import { compileDelegateTasks } from '@zhixuan92/multi-model-agent-core/intake/compilers/delegate';
import { runIntakePipeline } from '@zhixuan92/multi-model-agent-core/intake/pipeline';
import { ClarificationStore } from '@zhixuan92/multi-model-agent-core/intake/clarification-store';
import { buildClarificationAwareResponse } from './clarification-response.js';
import { registerConfirmClarifications } from './tools/confirm-clarifications.js';

export { computeTimings, computeBatchProgress, computeAggregateCost } from './tools/batch-response.js';

export const SERVER_NAME = 'multi-model-agent';
const DEFAULT_LARGE_RESPONSE_THRESHOLD_CHARS = 65_536;

function parsePositiveInt(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  if (Number.isFinite(n) && n > 0 && String(n) === s.trim()) return n;
  return undefined;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function buildFullResponse(
  batchId: string,
  tasks: TaskSpec[],
  results: RunResult[],
  aggregates: {
    timings: BatchTimings;
    batchProgress: BatchProgress;
    aggregateCost: BatchAggregateCost;
  },
) {
  return {
    schemaVersion: '1.0.0',
    batchId,
    mode: 'full' as const,
    headline: composeHeadline({
      timings: aggregates.timings,
      batchProgress: aggregates.batchProgress,
      aggregateCost: aggregates.aggregateCost,
      taskSpecs: tasks,
    }),
    timings: aggregates.timings,
    batchProgress: aggregates.batchProgress,
    aggregateCost: aggregates.aggregateCost,
    results: results.map((r, i) => ({
      agentType: tasks[i].agentType ?? '(auto)',
      status: r.status,
      output: r.output,
      turns: r.turns,
      durationMs: r.durationMs,
      filesRead: r.filesRead,
      filesWritten: r.filesWritten,
      directoriesListed: r.directoriesListed,
      toolCalls: r.toolCalls,
      escalationLog: r.escalationLog,
      usage: r.usage,
      terminationReason: r.terminationReason,
      specReviewStatus: r.specReviewStatus,
      qualityReviewStatus: r.qualityReviewStatus,
      agents: r.agents,
      implementationReport: r.implementationReport,
      specReviewReport: r.specReviewReport,
      qualityReviewReport: r.qualityReviewReport,
      ...(r.error && { error: r.error }),
    })),
  };
}

function buildSummaryResponse(
  batchId: string,
  tasks: TaskSpec[],
  results: RunResult[],
  opts: {
    autoEscaped: boolean;
    totalOutputChars: number;
    threshold: number;
    timings: BatchTimings;
    batchProgress: BatchProgress;
    aggregateCost: BatchAggregateCost;
  },
) {
  return {
    schemaVersion: '1.0.0',
    batchId,
    mode: 'summary' as const,
    headline: composeHeadline({
      timings: opts.timings,
      batchProgress: opts.batchProgress,
      aggregateCost: opts.aggregateCost,
      taskSpecs: tasks,
    }),
    ...(opts.autoEscaped && {
      note: `Combined output was ${opts.totalOutputChars} chars (threshold: ${opts.threshold}). Auto-switched to summary mode. Use get_batch_slice({ batchId, slice: 'output', taskIndex }) to fetch individual task outputs, or get_batch_slice({ batchId, slice: 'detail', taskIndex }) for per-task metadata.`,
    }),
    timings: opts.timings,
    batchProgress: opts.batchProgress,
    aggregateCost: opts.aggregateCost,
    results: results.map((r, i) => ({
      taskIndex: i,
      agentType: tasks[i].agentType ?? '(auto)',
      status: r.status,
      turns: r.turns,
      durationMs: r.durationMs,
      outputLength: r.output.length,
      outputSha256: sha256Hex(r.output),
      usage: r.usage,
      escalationChain: r.escalationLog.map((a) => `${a.provider}:${a.status}`),
      terminationReason: r.terminationReason,
      specReviewStatus: r.specReviewStatus,
      qualityReviewStatus: r.qualityReviewStatus,
      ...(r.error && { error: r.error }),
      ...(r.errorCode && { errorCode: r.errorCode }),
      ...(r.retryable !== undefined && { retryable: r.retryable }),
      _fetchWith: `get_batch_slice({ batchId: "${batchId}", slice: "output", taskIndex: ${i} })`,
    })),
  };
}
// Read the version from package.json at module load so the MCP server
// metadata (and tests that assert against it) stays in lockstep with the
// published npm package version. `createRequire` keeps the JSON read
// outside tsc's `rootDir: src` constraint and avoids the `with { type:
// 'json' }` import attribute (which would force us to commit to a
// specific TS/Node module-resolution combination). The relative path is
// resolved from the compiled `dist/cli.js` — that sits one level below
// `packages/mcp/package.json`.
const packageRequire = createRequire(import.meta.url);
const pkg = packageRequire('../package.json') as { version: string };
export const SERVER_VERSION = pkg.version;

export function buildTaskSchema(availableAgents: [string, ...string[]]) {
  return z.object({
    prompt: z.string().describe(
      'The task instruction. Required.',
    ),
    agentType: z.enum(availableAgents).optional().describe(
      'How hard the task is. Default: standard (cost-effective). Set to complex for harder reasoning or ambiguous scope.',
    ),
    filePaths: z.array(z.string()).optional().describe(
      'Files the sub-agent should focus on. Existing files are pre-verified. Non-existent paths are treated as output targets.',
    ),
    done: z.string().optional().describe(
      'Acceptance criteria in plain language. The worker works toward this goal. The reviewer verifies it.',
    ),
    contextBlockIds: z.array(z.string()).optional().describe(
      'IDs from register_context_block to prepend to prompt.',
    ),
  }).strict();
}

/**
 * Batch cache for `retry_tasks`. Every `delegate_tasks` call stashes the
 * original `TaskSpec[]` under a UUID so the caller can later ask us to
 * re-dispatch specific indices without re-transmitting the briefs. Two
 * bounds:
 *
 *   - TTL (30 min from creation): keeps stale batches from lingering
 *     through a long session. TTL is from-creation (not from-last-access),
 *     matching `InMemoryContextBlockStore` — a batch used at minute 29
 *     still dies at minute 30. Access does NOT refresh the expiry.
 *   - LRU cap (100 entries): prevents unbounded growth from a chatty
 *     caller that never retries. Eviction is true LRU (least-recently-
 *     *used*, not least-recently-inserted): a batch that is still being
 *     retried stays hot and a newer but unused batch will be evicted
 *     first. This matters when a caller is iterating on one task while
 *     dispatching unrelated batches in parallel.
 *
 * Eviction on TTL is lazy (checked on `retry_tasks` lookup). Eviction on
 * the LRU cap is eager (runs after every `rememberBatch`).
 *
 * LRU implementation note: we use JavaScript's `Map` which preserves
 * insertion order on iteration. To "touch" an entry on access, we
 * `delete` it and re-`set` it, which moves it to the end of the
 * iteration order. `Map.keys().next().value` is then the oldest-*accessed*
 * entry (not the oldest-inserted entry), giving us O(1) LRU without a
 * separate priority structure. The helpers `touchBatch` (on access) and
 * the eviction loop in `rememberBatch` (on insert) are the only two
 * places that mutate the Map.
 */
const BATCH_TTL_MS = 30 * 60 * 1000;
const BATCH_MAX = 100;

export function buildMcpServer(
  config: Parameters<typeof runTasks>[1],
  options?: {
    /** Character threshold that triggers auto-switch from 'full' to
     *  'summary' response mode when the caller uses `responseMode: 'auto'`
     *  (the default). Defaults to 65_536, tuned for Claude Code's inline
     *  rendering limit. Precedence (highest first): env var
     *  MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS > config file
     *  defaults.largeResponseThresholdChars > this option > default. */
    largeResponseThresholdChars?: number;
    /** Internal test-only hook for injecting a stubbed runTasks implementation. */
    _testRunTasksOverride?: typeof runTasks;
  },
) {
  const agentKeys = config.agents ? Object.keys(config.agents) : [];
  if (agentKeys.length === 0) {
    throw new Error('buildMcpServer requires at least one configured agent.');
  }

  // Resolve the threshold once at server startup
  const envThreshold = parsePositiveInt(process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS);
  if (process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS !== undefined && envThreshold === undefined) {
    process.stderr.write(
      `[multi-model-agent] warning: MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS=${process.env.MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS} is not a positive integer, ignoring\n`,
    );
  }
  const resolvedThreshold =
    envThreshold
    ?? config.defaults.largeResponseThresholdChars
    ?? options?.largeResponseThresholdChars
    ?? DEFAULT_LARGE_RESPONSE_THRESHOLD_CHARS;
  const runTasksImpl = options?._testRunTasksOverride ?? runTasks;

  function injectDefaults(tasks: TaskSpec[]): TaskSpec[] {
    return tasks.map(t => ({
      ...t,
      agentType: t.agentType as TaskSpec['agentType'],
      tools: config.defaults.tools,
      timeoutMs: config.defaults.timeoutMs,
      maxCostUSD: config.defaults.maxCostUSD,
      sandboxPolicy: config.defaults.sandboxPolicy,
      cwd: process.cwd(),
      reviewPolicy: 'full',
      effort: undefined,
    }));
  }

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // One context-block store per server instance. Persists across calls
  // within a single `buildMcpServer(...)` lifetime so `register_context_block`
  // followed by multiple `delegate_tasks` with `contextBlockIds` works.
  const contextBlockStore = new InMemoryContextBlockStore();

  // Clarification store for intake clarification flow
  const clarificationStore = new ClarificationStore();

  // Per-server batch cache for `retry_tasks`. See the LRU comment block
  // above for eviction semantics.
  const batchCache = new Map<string, {
    tasks: TaskSpec[];
    results?: RunResult[];
    expiresAt: number;
  }>();

  const rememberBatch = (tasks: TaskSpec[]): string => {
    const id = randomUUID();
    batchCache.set(id, { tasks, expiresAt: Date.now() + BATCH_TTL_MS });
    // Evict the least-recently-USED entry (not least-recently-inserted).
    // `touchBatch` below moves accessed entries to the end of insertion
    // order, so `keys().next().value` is the true LRU head.
    while (batchCache.size > BATCH_MAX) {
      const lru = batchCache.keys().next().value;
      if (lru) batchCache.delete(lru);
      else break;
    }
    return id;
  };

  /**
   * Mark a batch as recently used by reinserting it at the tail of the
   * Map's iteration order. `touchBatch` is called on every successful
   * `retry_tasks` lookup so a frequently-retried batch does not get
   * evicted by `rememberBatch`'s LRU loop. Does NOT refresh the TTL —
   * expiry stays at the original creation time.
   */
  const touchBatch = (id: string, entry: { tasks: TaskSpec[]; results?: RunResult[]; expiresAt: number }): void => {
    batchCache.delete(id);
    batchCache.set(id, entry);
  };

  const availableAgents = agentKeys as [string, ...string[]];

  server.tool(
    'delegate_tasks',
    'Dispatch tasks to sub-agents. Minimum: { prompt }. Everything else has good defaults.\n\n' +
      'Set filePaths whenever the task targets specific files. Set done whenever you have explicit acceptance criteria (required). ' +
      'Do not invent extra fields such as inputs or done_condition; put extra context in prompt and use only the public schema fields.\n\n' +
      'Use specialized tools (audit_document, review_code, verify_work, debug_task) for common patterns. ' +
      'Use delegate_tasks for custom work.\n\n' +
      renderProviderRoutingMatrix(config),
    {
      tasks: z.array(buildTaskSchema(availableAgents)).describe('Array of tasks to execute in parallel'),
      responseMode: z.enum(['full', 'summary', 'auto']).optional().describe(
        `How to shape the response envelope. 'full' (default via 'auto') includes each task's output inline. ` +
        `'summary' returns per-task metadata + outputLength + outputSha256, with full outputs fetchable via ` +
        `get_batch_slice. 'auto' (the default) returns 'full' when combined output fits under the server's ` +
        `threshold (default 65 KB; configurable via env / config / buildMcpServer option), otherwise 'summary' ` +
        `with an auto-escape note.`,
      ),
    },
    async ({ tasks, responseMode = 'auto' }, extra) => {
      const rawToken = extra._meta?.progressToken;
      const progressToken: string | number | undefined =
        typeof rawToken === 'string' || typeof rawToken === 'number'
          ? rawToken
          : undefined;
      let progressCounter = 0;
      const sendProgress = progressToken !== undefined
        ? (taskIndex: number, event: ProgressEvent) => {
            progressCounter += 1;
            extra.sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: progressCounter,
                message: JSON.stringify({ taskIndex, event }),
              },
            }).catch(() => { /* ignore */ });
          }
        : undefined;

      // Intake pipeline: compile → infer → classify → resolve
      const requestId = randomUUID();
      const drafts = compileDelegateTasks(tasks as { prompt: string; done?: string; filePaths?: string[]; agentType?: string; contextBlockIds?: string[] }[], requestId);
      const intakeResult = runIntakePipeline(drafts, config, contextBlockStore);

      // Execute ready tasks through normal dispatch
      let results: RunResult[] = [];
      const readySpecs = intakeResult.ready.map(r => r.task);
      const batchId = rememberBatch(readySpecs.length > 0 ? readySpecs : (tasks as TaskSpec[]));

      const batchStartMs = Date.now();
      try {
        if (readySpecs.length > 0) {
          const resolvedTasks = injectDefaults(readySpecs);
          results = await runTasksImpl(resolvedTasks, config, {
            onProgress: sendProgress,
            runtime: { contextBlockStore },
          });
          intakeResult.intakeProgress.executedDrafts = results.length;
        }
      } finally {
        // Always attach results so get_batch_slice/retry_tasks can find the batch
        const batchEntry = batchCache.get(batchId);
        if (batchEntry) batchEntry.results = results;
      }
      const wallClockMs = Date.now() - batchStartMs;

      // Create clarification set if needed
      let clarificationId: string | undefined;
      if (intakeResult.clarifications.length > 0) {
        const storedDrafts = intakeResult.clarifications.map(c => ({
          draft: drafts.find(d => d.draftId === c.draftId)!,
          taskIndex: c.taskIndex,
          roundCount: 0,
        }));
        clarificationId = clarificationStore.create(storedDrafts, batchId);
      }

      // Build response using existing envelope (timings, batchProgress, aggregateCost)
      // plus intake-specific fields (clarifications, intakeProgress)
      const totalOutputChars = results.reduce((sum, r) => sum + r.output.length, 0);
      const effectiveMode: 'full' | 'summary' =
        responseMode === 'full'
          ? 'full'
          : responseMode === 'summary'
            ? 'summary'
            : totalOutputChars > resolvedThreshold
              ? 'summary'
              : 'full';

      const timings = computeTimings(wallClockMs, results);
      const batchProgress = computeBatchProgress(results);
      const aggregateCost = computeAggregateCost(results);

      // Use original tasks (not readySpecs) for response building so parentModel
      // and other caller-provided fields are available for headline computation
      const responseTasks = intakeResult.ready.map((r, i) => ({
        ...readySpecs[i],
        ...(tasks as TaskSpec[])[r.taskIndex],
        prompt: readySpecs[i].prompt, // keep the resolved prompt
      }));

      const baseResponse =
        effectiveMode === 'full'
          ? buildFullResponse(batchId, responseTasks, results, { timings, batchProgress, aggregateCost })
          : buildSummaryResponse(batchId, responseTasks, results, {
              autoEscaped: responseMode === 'auto' && totalOutputChars > resolvedThreshold,
              totalOutputChars,
              threshold: resolvedThreshold,
              timings,
              batchProgress,
              aggregateCost,
            });

      // Merge intake fields into the response
      const response = {
        ...baseResponse,
        schemaVersion: '2.1.0',
        intakeProgress: intakeResult.intakeProgress,
        ...(intakeResult.clarifications.length > 0 && {
          clarifications: intakeResult.clarifications,
        }),
        ...(clarificationId && { clarificationId }),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'register_context_block',
    'Store a reusable content block for later delegate_tasks calls. Returns a block id.\n\n' +
      'When this saves money:\n' +
      '- You\'re dispatching 3+ tasks that all need the same file or spec as context\n' +
      '- You\'re doing multiple rounds of review/audit on the same document\n' +
      '- Your shared context is >2K tokens (below that, duplication cost is negligible)\n\n' +
      'Example workflow:\n' +
      '  1. register_context_block({ content: <spec file contents> })  -> { id: "abc123" }\n' +
      '  2. delegate_tasks({ tasks: [\n' +
      '       { prompt: "Review section 1", contextBlockIds: ["abc123"] },\n' +
      '       { prompt: "Review section 2", contextBlockIds: ["abc123"] },\n' +
      '       { prompt: "Review section 3", contextBlockIds: ["abc123"] }\n' +
      '     ]})\n' +
      '  -> The spec is transmitted once to the server, not three times.\n\n' +
      'Without context blocks: 3 tasks x 25K tokens = 75K input tokens transmitted.\n' +
      'With context blocks: 25K stored once + 3 x reference = ~25K total.\n\n' +
      'Blocks live in an in-memory store with a 30-minute TTL and 100-entry LRU cap.\n' +
      'If a block expires before use, delegate_tasks returns an error identifying the missing id.',
    {
      id: z.string().optional().describe('Optional id; auto-generated UUID if omitted'),
      content: z.string().describe('The content to store'),
    },
    async ({ id, content }) => {
      const result = contextBlockStore.register(content, { id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'retry_tasks',
    'Re-run specific tasks from a previous delegate_tasks batch.\n\n' +
      'When to use:\n' +
      '- A task returned \'incomplete\' but you believe a retry will succeed\n' +
      '  (e.g., after fixing a file the task depends on, or after a parallel conflict is resolved)\n' +
      '- You want to re-run a subset of a batch without re-transmitting prompts and context blocks\n\n' +
      'When NOT to use (re-dispatch via delegate_tasks instead):\n' +
      '- You need to change the task prompt, tools, effort, or limits\n' +
      '- The original batch is older than 30 minutes (cache TTL)\n' +
      '- You want to try a different provider or agent type\n\n' +
      'Pass the batchId returned by delegate_tasks and an array of 0-based task indices.\n' +
      'Batches live in an in-memory cache with a 30-minute TTL and 100-entry LRU cap.',
    {
      batchId: z.string().describe('Batch id returned from a previous delegate_tasks call'),
      taskIndices: z
        .array(z.number().int().nonnegative())
        .describe('Zero-based indices (into the original batch) of the tasks to re-run'),
      responseMode: z.enum(['full', 'summary', 'auto']).optional().describe(
        `How to shape the response envelope for the retry batch. 'full' returns inline outputs. ` +
        `'summary' returns outputLength + outputSha256. 'auto' (default) auto-escapes based on threshold.`,
      ),
    },
    async ({ batchId, taskIndices, responseMode = 'auto' }) => {
      const batch = batchCache.get(batchId);
      if (!batch || batch.expiresAt < Date.now()) {
        // Proactively drop the expired entry so subsequent lookups see
        // the same "unknown" result and the cache doesn't slowly fill
        // with stale rows that are never touched again.
        if (batch) batchCache.delete(batchId);
        throw new Error(
          `batch "${batchId}" is unknown or expired — re-dispatch with full task specs via delegate_tasks`,
        );
      }
      // Mark this batch as recently used so the LRU eviction in
      // `rememberBatch` doesn't drop a hot entry when newer batches
      // arrive. Does NOT refresh TTL — a batch created 29 minutes ago
      // still dies at minute 30 even if it's retried heavily.
      touchBatch(batchId, batch);
      for (const i of taskIndices) {
        if (i < 0 || i >= batch.tasks.length) {
          throw new Error(
            `index ${i} is out of range for batch ${batchId} (size ${batch.tasks.length})`,
          );
        }
      }
      const subset = taskIndices.map((i) => batch.tasks[i]);

      // Create a fresh batch for the retried tasks so the original batch
      // entry is preserved and get_batch_slice can still retrieve it.
      const retryBatchId = rememberBatch(subset);

      const batchStartMs = Date.now();
      let results: RunResult[] = [];
      try {
        results = await runTasksImpl(injectDefaults(subset), config, {
          runtime: { contextBlockStore },
        });
      } finally {
        const retryEntry = batchCache.get(retryBatchId);
        if (retryEntry) retryEntry.results = results;
      }
      const wallClockMs = Date.now() - batchStartMs;

      // Determine effective response mode
      const totalOutputChars = results.reduce((sum, r) => sum + r.output.length, 0);
      const effectiveMode: 'full' | 'summary' =
        responseMode === 'full'
          ? 'full'
          : responseMode === 'summary'
            ? 'summary'
            : totalOutputChars > resolvedThreshold
              ? 'summary'
              : 'full';

      const timings = computeTimings(wallClockMs, results);
      const batchProgress = computeBatchProgress(results);
      const aggregateCost = computeAggregateCost(results);

      const response =
        effectiveMode === 'full'
          ? {
              ...buildFullResponse(retryBatchId, subset, results, { timings, batchProgress, aggregateCost }),
              originalBatchId: batchId,
              originalIndices: taskIndices,
            }
          : {
              ...buildSummaryResponse(retryBatchId, subset, results, {
                autoEscaped: responseMode === 'auto' && totalOutputChars > resolvedThreshold,
                totalOutputChars,
                threshold: resolvedThreshold,
                timings,
                batchProgress,
                aggregateCost,
              }),
              originalBatchId: batchId,
              originalIndices: taskIndices,
            };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'get_batch_slice',
    `Retrieve a specific "slice" of data from a previous delegate_tasks batch.

Three slices are available:
- \`output\`: The full text output of a specific task (requires taskIndex).
- \`detail\`: Per-task execution details including toolCalls, filesRead/Written/Listed,
  escalationLog, terminationReason, review statuses (specReviewStatus,
  qualityReviewStatus), agents provenance, and implementation/spec/quality reports
  (requires taskIndex).
- \`telemetry\`: Batch-wide ROI telemetry envelope with headline, timings, batchProgress,
  and aggregateCost (taskIndex not needed).

Batches are cached in memory per MCP server instance with a 30-minute TTL from creation
and a 100-entry LRU cap. Access touches the LRU order but does not refresh TTL. If the
batch is expired or evicted, re-dispatch via delegate_tasks with the full specs.`,
    {
      batchId: z.string().describe('Batch id returned from a previous delegate_tasks call'),
      slice: z.enum(['output', 'detail', 'telemetry']).describe('Which slice to retrieve'),
      taskIndex: z.number().int().nonnegative().optional().describe('Zero-based index of the task (required for output and detail slices)'),
    },
    async ({ batchId, slice, taskIndex }) => {
      const batch = batchCache.get(batchId);
      if (!batch || batch.expiresAt < Date.now()) {
        if (batch) batchCache.delete(batchId);
        throw new Error(
          `batch "${batchId}" is unknown or expired — re-dispatch with full task specs via delegate_tasks`,
        );
      }

      touchBatch(batchId, batch);

      if (batch.results === undefined) {
        throw new Error(
          `batch "${batchId}" has no results yet — the original dispatch may still be running`,
        );
      }

      if (slice === 'output' || slice === 'detail') {
        if (taskIndex === undefined) {
          throw new Error(
            `taskIndex is required for slice "${slice}" — please specify which task to retrieve`,
          );
        }
        if (taskIndex < 0 || taskIndex >= batch.results.length) {
          throw new Error(
            `index ${taskIndex} is out of range for batch ${batchId} (size ${batch.results.length})`,
          );
        }
      }

      if (slice === 'output') {
        const result = batch.results[taskIndex!];
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ output: result.output }, null, 2) }],
        };
      }

      if (slice === 'detail') {
        const result = batch.results[taskIndex!];
        const task = batch.tasks[taskIndex!];

        const detail = {
          batchId,
          taskIndex: taskIndex,
          agentType: task.agentType ?? '(auto)',
          filesRead: result.filesRead,
          filesWritten: result.filesWritten,
          directoriesListed: result.directoriesListed ?? [],
          toolCalls: result.toolCalls,
          escalationLog: result.escalationLog,
          terminationReason: result.terminationReason,
          specReviewStatus: result.specReviewStatus,
          qualityReviewStatus: result.qualityReviewStatus,
          agents: result.agents,
          implementationReport: result.implementationReport,
          specReviewReport: result.specReviewReport,
          qualityReviewReport: result.qualityReviewReport,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }],
        };
      }

      // slice === 'telemetry'
      const wallClockMsEstimate = Math.max(
        0,
        ...batch.results.map((r) => r.durationMs ?? 0),
      );
      const timings = computeTimings(wallClockMsEstimate, batch.results);
      const batchProgress = computeBatchProgress(batch.results);
      const aggregateCost = computeAggregateCost(batch.results);
      const headline = composeHeadline({
        timings,
        batchProgress,
        aggregateCost,
        taskSpecs: batch.tasks,
      });

      const envelope = {
        batchId,
        headline,
        timings,
        batchProgress,
        aggregateCost,
        results: batch.results.map((r, i) => ({
          taskIndex: i,
          agentType: batch.tasks[i].agentType ?? '(auto)',
          status: r.status,
          turns: r.turns,
          durationMs: r.durationMs,
          usage: r.usage,
          escalationChain: r.escalationLog.map((a) => `${a.provider}:${a.status}`),
      ...(r.error && { error: r.error }),
      ...(r.errorCode && { errorCode: r.errorCode }),
      ...(r.retryable !== undefined && { retryable: r.retryable }),
        })),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
      };
    },
  );

  registerAuditDocument(server, config);
  registerDebugTask(server, config);
  registerReviewCode(server, config);
  registerVerifyWork(server, config);

  registerConfirmClarifications(
    server,
    config,
    clarificationStore,
    runTasksImpl as unknown as (tasks: unknown[], config: MultiModelConfig, options: unknown) => Promise<unknown[]>,
    rememberBatch as (tasks: unknown[]) => string,
  );

  return server;
}

/**
 * MCP CLI config discovery (owned by MCP, not core):
 * 1. --config <path> argument (explicit)
 * 2. MULTI_MODEL_CONFIG environment variable
 * 3. ~/.multi-model/config.json (default home-directory location)
 */
export async function discoverConfig(): Promise<MultiModelConfig> {
  const args = process.argv.slice(2);

  // 1. Explicit --config
  const configFlagIdx = args.indexOf('--config');
  if (configFlagIdx >= 0 && args[configFlagIdx + 1]) {
    return loadConfigFromFile(args[configFlagIdx + 1]);
  }

  // 2. MULTI_MODEL_CONFIG env var (file path)
  const envPath = process.env.MULTI_MODEL_CONFIG;
  if (envPath) {
    return loadConfigFromFile(envPath);
  }

  // 3. ~/.multi-model/config.json
  const defaultPath = path.join(os.homedir(), '.multi-model', 'config.json');
  if (fs.existsSync(defaultPath)) {
    return loadConfigFromFile(defaultPath);
  }

  // Fallback: empty config with required agents
  return parseConfig({
    agents: {
      standard: { type: 'claude', model: 'claude-sonnet-4-6' },
      complex: { type: 'claude', model: 'claude-sonnet-4-6' },
    },
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: multi-model-agent serve [--config <path>]');
    process.exit(0);
  }

  if (args[0] !== 'serve') {
    console.error('Usage: multi-model-agent serve [--config <path>]');
    process.exit(1);
  }

  const config = await discoverConfig();
  const agentNames = config.agents ? Object.keys(config.agents) : [];

  if (agentNames.length === 0) {
    console.error('No agents configured. Create ~/.multi-model/config.json or pass --config <path>.');
    process.exit(1);
  }

  const server = buildMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run main when executed directly
const thisFile = fileURLToPath(import.meta.url);
const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(thisFile);
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
