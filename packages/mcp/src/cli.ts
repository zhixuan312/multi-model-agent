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
} from '@zhixuan92/multi-model-agent-core';
import { renderProviderRoutingMatrix } from './routing/render-provider-routing-matrix.js';
import { composeHeadline } from './headline.js';

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

export function computeTimings(wallClockMs: number, results: RunResult[]): BatchTimings {
  const sumOfTaskMs = results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const estimatedParallelSavingsMs = Math.max(0, sumOfTaskMs - wallClockMs);
  return { wallClockMs, sumOfTaskMs, estimatedParallelSavingsMs };
}

export function computeBatchProgress(results: RunResult[]): BatchProgress {
  const totalTasks = results.length;
  const completedTasks = results.filter((r) => r.status === 'ok').length;
  const incompleteTasks = results.filter(
    (r) => r.status === 'incomplete' || r.status === 'max_turns' || r.status === 'timeout',
  ).length;
  const failedTasks = results.filter(
    (r) =>
      r.status === 'error' ||
      r.status === 'api_aborted' ||
      r.status === 'api_error' ||
      r.status === 'network_error',
  ).length;
  const successPercent =
    totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 1000) / 10;
  return { totalTasks, completedTasks, incompleteTasks, failedTasks, successPercent };
}

export function computeAggregateCost(results: RunResult[]): BatchAggregateCost {
  let totalActualCostUSD = 0;
  let totalSavedCostUSD = 0;
  let actualCostUnavailableTasks = 0;
  let savedCostUnavailableTasks = 0;

  for (const r of results) {
    if (r.usage.costUSD === null || r.usage.costUSD === undefined) {
      actualCostUnavailableTasks += 1;
    } else {
      totalActualCostUSD += r.usage.costUSD;
    }
    if (r.usage.savedCostUSD === null || r.usage.savedCostUSD === undefined) {
      savedCostUnavailableTasks += 1;
    } else {
      totalSavedCostUSD += r.usage.savedCostUSD;
    }
  }

  return {
    totalActualCostUSD,
    totalSavedCostUSD,
    actualCostUnavailableTasks,
    savedCostUnavailableTasks,
  };
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
      provider: tasks[i].provider ?? '(auto)',
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
      ...(r.progressTrace && { progressTrace: r.progressTrace }),
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
    batchId,
    mode: 'summary' as const,
    headline: composeHeadline({
      timings: opts.timings,
      batchProgress: opts.batchProgress,
      aggregateCost: opts.aggregateCost,
      taskSpecs: tasks,
    }),
    ...(opts.autoEscaped && {
      note: `Combined output was ${opts.totalOutputChars} chars (threshold: ${opts.threshold}). Auto-switched to summary mode. Use get_task_output({ batchId, taskIndex }) to fetch individual task outputs, or get_task_detail({ batchId, taskIndex }) for per-task metadata.`,
    }),
    timings: opts.timings,
    batchProgress: opts.batchProgress,
    aggregateCost: opts.aggregateCost,
    results: results.map((r, i) => ({
      taskIndex: i,
      provider: tasks[i].provider ?? '(auto)',
      status: r.status,
      turns: r.turns,
      durationMs: r.durationMs,
      outputLength: r.output.length,
      outputSha256: sha256Hex(r.output),
      usage: r.usage,
      escalationChain: r.escalationLog.map((a) => `${a.provider}:${a.status}`),
      ...(r.error && { error: r.error }),
      _fetchOutputWith: `get_task_output({ batchId: "${batchId}", taskIndex: ${i} })`,
      _fetchDetailWith: `get_task_detail({ batchId: "${batchId}", taskIndex: ${i} })`,
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

export function buildTaskSchema(availableProviders: [string, ...string[]]) {
  return z.object({
    prompt: z.string().describe('Task prompt for the sub-agent'),
    provider: z.enum(availableProviders).describe('Provider name').optional(),
    tier: z.enum(['trivial', 'standard', 'reasoning'])
      .describe('Required quality tier.'),
    requiredCapabilities: z.array(z.enum([
      'file_read', 'file_write', 'grep', 'glob',
      'shell', 'web_search', 'web_fetch',
    ])).describe('Capabilities this task requires. Empty array if none.'),
    tools: z.enum(['none', 'full']).optional().describe('Tool access mode. Default: full'),
    maxTurns: z.number().int().positive().optional().describe('Max agent loop turns. Default: 200'),
    timeoutMs: z.number().int().positive().optional().describe('Timeout in ms. Default: 600000'),
    cwd: z.string().optional().describe('Working directory for file/shell tools'),
    effort: z.enum(['none', 'low', 'medium', 'high']).optional()
      .describe("Reasoning effort."),
    sandboxPolicy: z.enum(['none', 'cwd-only']).optional().describe('File-system confinement policy. Default: cwd-only'),
    contextBlockIds: z.array(z.string()).optional().describe(
      'Optional context block ids previously stored via register_context_block. ' +
      'The server resolves each id to its stored content and prepends the blocks ' +
      '(in order, separated by "\\n\\n---\\n\\n") to `prompt` before dispatch. ' +
      'Use this to avoid re-transmitting long briefs across multiple calls.',
    ),
    expectedCoverage: z.object({
      minSections: z.number().int().positive().optional()
        .describe('Minimum section count expected in the output.'),
      sectionPattern: z.string().optional()
        .describe('Regex for section headings, applied with the multiline flag.'),
      requiredMarkers: z.array(z.string()).optional()
        .describe('Substrings that must all appear somewhere in the output.'),
    }).optional().describe(
      'Optional caller-declared output expectations used for semantic incompleteness detection.',
    ),
    skipCompletionHeuristic: z.boolean().optional().describe(
      'Opt-out: when true, the runner skips the no_terminator/fragment short-output ' +
      'heuristics. Use for tight-format outputs (verdicts, CSV rows, opaque ids). ' +
      'empty/thinking_only still fire. expectedCoverage passing is also authoritative.',
    ),
    includeProgressTrace: z.boolean().optional().describe(
      'Opt in to returning the bounded post-hoc progress trace for this task.',
    ),
    parentModel: z.string().optional().describe(
      'Optional parent-session model identifier used to estimate savedCostUSD.',
    ),
  });
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
  },
) {
  const providerKeys = Object.keys(config.providers);
  if (providerKeys.length === 0) {
    throw new Error('buildMcpServer requires at least one configured provider.');
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

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // One context-block store per server instance. Persists across calls
  // within a single `buildMcpServer(...)` lifetime so `register_context_block`
  // followed by multiple `delegate_tasks` with `contextBlockIds` works.
  const contextBlockStore = new InMemoryContextBlockStore();

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

  const availableProviders = providerKeys as [string, ...string[]];

  server.tool(
    'delegate_tasks',
    renderProviderRoutingMatrix(config),
    {
      tasks: z.array(buildTaskSchema(availableProviders)).describe('Array of tasks to execute in parallel'),
      responseMode: z.enum(['full', 'summary', 'auto']).optional().describe(
        `How to shape the response envelope. 'full' (default via 'auto') includes each task's output inline. ` +
        `'summary' returns per-task metadata + outputLength + outputSha256, with full outputs fetchable via ` +
        `get_task_output. 'auto' (the default) returns 'full' when combined output fits under the server's ` +
        `threshold (default 65 KB; configurable via env / config / buildMcpServer option), otherwise 'summary' ` +
        `with an auto-escape note.`,
      ),
    },
    async ({ tasks, responseMode = 'auto' }, extra) => {
      // --- OQ#6 resolution: MCP SDK progress notification API ---
      //
      // The @modelcontextprotocol/sdk >= 1.x exposes progress notifications
      // on the tool-handler `extra` argument: the second parameter of the
      // tool callback is `RequestHandlerExtra<ServerRequest, ServerNotification>`
      // (see node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts
      // line 173, and server/mcp.d.ts line 250 for `BaseToolCallback`).
      //
      // That type carries two things we need:
      //   1. `extra._meta.progressToken?: string | number` — present iff the
      //      client opted in by sending `_meta.progressToken` with its
      //      `tools/call` request (MCP spec: notifications/progress).
      //   2. `extra.sendNotification(notification)` — a request-scoped sender
      //      that emits `ServerNotification`s correlated with this call.
      //      `ServerNotification` is a union that includes
      //      `ProgressNotificationSchema` with method `"notifications/progress"`
      //      and params `{ progressToken, progress, total?, message? }`
      //      (types.d.ts line 954).
      //
      // So the bridge is: for each `ProgressEvent` we receive from core, if
      // the client supplied a `progressToken`, emit one `notifications/progress`
      // message whose `message` field is a JSON-encoded envelope. This is an
      // opt-in channel — clients that don't send `progressToken` get zero
      // notifications, preserving behavior for pre-streaming callers.
      //
      // Envelope schema (stable, documented here so clients can parse it):
      //
      //     params: {
      //       progressToken,                // echoed from the request _meta
      //       progress: <monotonic counter>,// ordinal of this event (1-based)
      //       message: JSON.stringify({
      //         taskIndex: <number>,        // index in the original `tasks` array
      //         event: <ProgressEvent>,     // full ProgressEvent union member
      //       }),
      //     }
      //
      // `total` is intentionally omitted: we don't know the final event count
      // in advance. Runners emit events in Tasks 9-11; this commit is plumbing
      // only and `escalation_start` (emitted by delegateWithEscalation itself)
      // is the sole observable event in practice.
      // Runtime guard instead of a raw cast: _meta is typed broadly at the
      // SDK layer, and a bad client could in principle send a progressToken
      // of any JSON type. Only `string` / `number` are valid per MCP spec.
      const rawToken = extra._meta?.progressToken;
      const progressToken: string | number | undefined =
        typeof rawToken === 'string' || typeof rawToken === 'number'
          ? rawToken
          : undefined;

      let progressCounter = 0;
      const sendProgress = progressToken !== undefined
        ? (taskIndex: number, event: ProgressEvent) => {
            progressCounter += 1;
            // Fire-and-forget. We swallow rejections so a broken transport
            // never corrupts the in-flight tool run — worst case the client
            // misses a progress tick but still gets the final tool result.
            extra
              .sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  progress: progressCounter,
                  message: JSON.stringify({ taskIndex, event }),
                },
              })
              .catch(() => {
                /* ignore — progress is best-effort */
              });
          }
        : undefined;

      // Stash the original task specs in the batch cache BEFORE dispatch
      // so the returned batchId is valid even if the dispatch itself
      // throws (so callers can still retry the specific tasks that
      // produced errors). The cache stores the raw TaskSpec[] — NOT the
      // expanded forms — because `retry_tasks` will push the same specs
      // through `runTasks` again, which re-expands against the current
      // (possibly updated) context-block store.
      const batchId = rememberBatch(tasks as TaskSpec[]);

      const batchStartMs = Date.now();
      let results: RunResult[] = [];
      try {
        results = await runTasks(tasks as TaskSpec[], config, {
          onProgress: sendProgress,
          runtime: { contextBlockStore },
        });
      } finally {
        // Always attach `results ?? []` so a mid-flight throw does not leave
        // a dangling batchCache entry that `get_task_output` can't distinguish
        // from "dispatch still in progress". Per spec §3.5 / §3.9 item 3.
        const batchEntry = batchCache.get(batchId);
        if (batchEntry) batchEntry.results = results;
      }
      const wallClockMs = Date.now() - batchStartMs;

      // Determine effective response mode based on the configurable threshold
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
          ? buildFullResponse(batchId, tasks, results, { timings, batchProgress, aggregateCost })
          : buildSummaryResponse(batchId, tasks, results, {
              autoEscaped: responseMode === 'auto' && totalOutputChars > resolvedThreshold,
              totalOutputChars,
              threshold: resolvedThreshold,
              timings,
              batchProgress,
              aggregateCost,
            });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'register_context_block',
    'Store a content block under an id (or auto-generated UUID) for reuse in later delegate_tasks calls. ' +
      'Use this to avoid re-transmitting long briefs on every dispatch. Blocks are referenced from a ' +
      'task via its `contextBlockIds` array — the server resolves each id to its stored content and ' +
      'prepends the blocks to the task `prompt` at dispatch time. Blocks live in an in-memory store ' +
      'with a 30-minute TTL and a 100-entry LRU cap.',
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
    'Re-run specific tasks from a previous delegate_tasks batch by their indices, without ' +
      're-transmitting the original briefs. Pass the `batchId` returned by delegate_tasks ' +
      'and an array of task indices (0-based) to re-dispatch. Batches live in an in-memory ' +
      'cache with a 30-minute TTL; if the batch has expired, re-dispatch the tasks explicitly ' +
      'via delegate_tasks.',
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
      // entry is preserved and get_task_output can still retrieve it.
      const retryBatchId = rememberBatch(subset);

      const batchStartMs = Date.now();
      let results: RunResult[] = [];
      try {
        results = await runTasks(subset, config, {
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
    'get_task_output',
    `Retrieve the full text output of a specific task from a previous delegate_tasks batch.

Use this when a prior delegate_tasks response came back with mode: 'summary' and you
need the actual output of one specific task. The batchId is the one returned at the
top of that response; taskIndex is 0-based into the original tasks array.

Batches are cached in memory per MCP server instance with a 30-minute TTL from creation
and a 100-entry LRU cap. Access touches the LRU order but does not refresh TTL. If the
batch is expired or evicted, re-dispatch via delegate_tasks with the full specs.`,
    {
      batchId: z.string().describe('Batch id returned from a previous delegate_tasks call'),
      taskIndex: z.number().int().nonnegative().describe('Zero-based index of the task within the batch'),
    },
    async ({ batchId, taskIndex }) => {
      const batch = batchCache.get(batchId);
      if (!batch || batch.expiresAt < Date.now()) {
        if (batch) batchCache.delete(batchId);
        throw new Error(
          `batch "${batchId}" is unknown or expired — re-dispatch with full task specs via delegate_tasks`,
        );
      }

      // Touch LRU order but NOT TTL
      touchBatch(batchId, batch);

      if (batch.results === undefined) {
        throw new Error(`batch "${batchId}" has no stored results — this may indicate a dispatch failure`);
      }

      if (taskIndex < 0 || taskIndex >= batch.results.length) {
        throw new Error(
          `index ${taskIndex} is out of range for batch ${batchId} (size ${batch.results.length})`,
        );
      }

      const result = batch.results[taskIndex];
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ output: result.output }, null, 2) }],
      };
    },
  );

  server.tool(
    'get_task_detail',
    `Retrieve per-task execution details (toolCalls, filesRead/Written/Listed, full escalationLog with reasons, progressTrace if opted in) for a task from a previous delegate_tasks batch. Use this when a batch returned in summary mode and you need to inspect what a specific task actually did — e.g., to debug a failure, verify file-write scope, or review the provider escalation chain. For the output text, use get_task_output instead. Batches live in an in-memory cache with a 30-minute TTL; if the batch is expired or evicted, re-dispatch via delegate_tasks with the full task specs.`,
    {
      batchId: z.string().describe('Batch id returned from a previous delegate_tasks call'),
      taskIndex: z.number().int().nonnegative().describe('Zero-based index of the task within the batch'),
    },
    async ({ batchId, taskIndex }) => {
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

      if (taskIndex < 0 || taskIndex >= batch.results.length) {
        throw new Error(
          `taskIndex ${taskIndex} is out of range for batch ${batchId} (batch has ${batch.results.length} tasks)`,
        );
      }

      const result = batch.results[taskIndex];
      const task = batch.tasks[taskIndex];

      const detail = {
        batchId,
        taskIndex,
        provider: task.provider ?? '(auto)',
        filesRead: result.filesRead,
        filesWritten: result.filesWritten,
        directoriesListed: result.directoriesListed ?? [],
        toolCalls: result.toolCalls,
        escalationLog: result.escalationLog,
        ...(result.progressTrace && { progressTrace: result.progressTrace }),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }],
      };
    },
  );

  server.tool(
    'get_batch_telemetry',
    `Retrieve a compact ROI telemetry envelope for a previous delegate_tasks batch: the one-line headline (tasks/success/wall-clock/cost/ROI), wall-clock vs serial timings, per-task cost and savings, and provider escalation chains. Use this after every delegate_tasks call to surface the ROI story to the user — especially when the primary response came back in summary mode or hit a client-side size limit. Envelope size: a ~600-byte header plus ~200 bytes per task (so a 10-task batch is ~2.6 KB; a 50-task batch is ~10 KB). Bounded-small per task, but scales linearly, so enormous batches (100+ tasks) may approach the client's tool-result size limit. Batches live in an in-memory cache with a 30-minute TTL; if the batch is expired, the numbers are lost.`,
    {
      batchId: z.string().describe('Batch id returned from a previous delegate_tasks call'),
    },
    async ({ batchId }) => {
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
          provider: batch.tasks[i].provider ?? '(auto)',
          status: r.status,
          turns: r.turns,
          durationMs: r.durationMs,
          usage: r.usage,
          escalationChain: r.escalationLog.map((a) => `${a.provider}:${a.status}`),
          ...(r.error && { error: r.error }),
        })),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
      };
    },
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

  // Fallback: empty config
  return parseConfig({});
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] !== 'serve') {
    console.error('Usage: multi-model-agent serve [--config <path>]');
    process.exit(1);
  }

  const config = await discoverConfig();
  const providerNames = Object.keys(config.providers);

  if (providerNames.length === 0) {
    console.error('No providers configured. Create ~/.multi-model/config.json or pass --config <path>.');
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
