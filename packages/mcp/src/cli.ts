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
import { InMemoryContextBlockStore, createDiagnosticLogger } from '@zhixuan92/multi-model-agent-core';
import type {
  MultiModelConfig,
  TaskSpec,
  ProgressEvent,
  RunResult,
  BatchTimings,
  BatchProgress,
  BatchAggregateCost,
  AgentCapability,
  DiagnosticLogger,
} from '@zhixuan92/multi-model-agent-core';
import { renderProviderRoutingMatrix } from './routing/render-provider-routing-matrix.js';
import { composeHeadline } from './headline.js';
import {
  computeTimings,
  computeBatchProgress,
  computeAggregateCost,
} from './tools/batch-response.js';
import { buildUnifiedResponse, withDiagnostics } from './tools/shared.js';
import { truncateResults } from './tools/truncation.js';
import { registerAuditDocument } from './tools/audit-document.js';
import { registerDebugTask } from './tools/debug-task.js';
import { registerExecutePlan } from './tools/execute-plan.js';
import { registerReviewCode } from './tools/review-code.js';
import { registerVerifyWork } from './tools/verify-work.js';
import { compileDelegateTasks } from '@zhixuan92/multi-model-agent-core/intake/compilers/delegate';
import { runIntakePipeline } from '@zhixuan92/multi-model-agent-core/intake/pipeline';
import { ClarificationStore } from '@zhixuan92/multi-model-agent-core/intake/clarification-store';
import { registerConfirmClarifications } from './tools/confirm-clarifications.js';

export { computeTimings, computeBatchProgress, computeAggregateCost } from './tools/batch-response.js';

export const SERVER_NAME = 'multi-model-agent';
export const ASSISTANT_MODEL_NAME = 'GPT-5';
const DEFAULT_LARGE_RESPONSE_THRESHOLD_CHARS = 65_536;

export function buildCliGreeting(): string {
  return `Hi! I'm ${ASSISTANT_MODEL_NAME}, your friendly multi-model agent assistant.`;
}

function parsePositiveInt(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  if (Number.isFinite(n) && n > 0 && String(n) === s.trim()) return n;
  return undefined;
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
  logger: DiagnosticLogger,
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

  // Resolve parentModel once: env var > config > undefined
  const resolvedParentModel =
    process.env.PARENT_MODEL_NAME || config.defaults.parentModel || undefined;

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
      parentModel: resolvedParentModel,
      autoCommit: true,
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
    'General-purpose task dispatch — use only when no specialized route fits. ' +
      'Try specialized tools first: audit_document (auditing), review_code (reviewing), verify_work (verifying), debug_task (debugging), execute_plan (implementing from a written plan/spec file on disk). ' +
      'Use delegate_tasks for ad-hoc implementation, research, or any work that has no plan file and no specialized route.\n\n' +
      'Minimum: { prompt }. Everything else has good defaults. ' +
      'Set filePaths whenever the task targets specific files. Set done whenever you have explicit acceptance criteria (required). ' +
      'Do not invent extra fields such as inputs or done_condition; put extra context in prompt and use only the public schema fields.\n\n' +
      renderProviderRoutingMatrix(config),
    {
      tasks: z.array(buildTaskSchema(availableAgents)).describe('Array of tasks to execute in parallel'),
    },
    async ({ tasks }, extra) => {
      const rawToken = extra._meta?.progressToken;
      const progressToken: string | number | undefined =
        typeof rawToken === 'string' || typeof rawToken === 'number'
          ? rawToken
          : undefined;
      let progressCounter = 0;
      const sendProgress = progressToken !== undefined
        ? (taskIndex: number, event: ProgressEvent) => {
            progressCounter += 1;
            const headline = `[task ${taskIndex}] ${event.headline}`;
            extra.sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: progressCounter,
                message: headline,
              },
            })
              .then(() => { logger.notification(headline, true); })
              .catch(() => { logger.notification(headline, false); });
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

      // Apply auto-escape truncation
      const truncatedResults = truncateResults(
        results.map(r => ({ status: r.status, output: r.output, filesWritten: r.filesWritten, error: r.error })),
        batchId,
        resolvedThreshold,
      );

      return buildUnifiedResponse({
        batchId,
        results: results.map((r, i) => ({ ...r, output: truncatedResults[i].output })),
        tasks: readySpecs,
        wallClockMs,
        parentModel: resolvedParentModel,
        clarificationId,
        clarifications: intakeResult.clarifications.length > 0 ? intakeResult.clarifications : undefined,
      });
    },
  );

  server.tool(
    'register_context_block',
    'Store a reusable content block for later delegate_tasks calls. Returns a block id.\n\n' +
      'When this saves money:\n' +
      '- You\'re dispatching 3+ tasks that all need the same file or spec as context\n' +
      '- You\'re doing multiple rounds of review/audit on the same document\n' +
      '- Your shared context is >2K tokens (below that, duplication cost is negligible)\n\n' +
      'Common patterns:\n' +
      '  Delta audit — Register round 1\'s audit report, then dispatch round 2 via\n' +
      '  delegate_tasks with contextBlockIds + a prompt like "Only report new findings\n' +
      '  not in the prior report, findings not fixed, and confirm which were fixed."\n' +
      '  This cuts audit cost roughly in half on subsequent rounds.\n\n' +
      '  Diff-scoped review — Register the git diff output, then dispatch review via\n' +
      '  delegate_tasks with contextBlockIds + a prompt like "Review only the changes\n' +
      '  in the diff, not the entire file." Focuses the reviewer on what changed.\n\n' +
      '  Shared spec — Register a spec/plan once, reference it from multiple parallel\n' +
      '  tasks. 3 tasks × 25K tokens = 75K transmitted; with a context block, ~25K total.\n\n' +
      'Example workflow:\n' +
      '  1. register_context_block({ content: <spec file contents> })  -> { id: "abc123" }\n' +
      '  2. delegate_tasks({ tasks: [\n' +
      '       { prompt: "Review section 1", contextBlockIds: ["abc123"] },\n' +
      '       { prompt: "Review section 2", contextBlockIds: ["abc123"] },\n' +
      '       { prompt: "Review section 3", contextBlockIds: ["abc123"] }\n' +
      '     ]})\n' +
      '  -> The spec is transmitted once to the server, not three times.\n\n' +
      'Blocks live in an in-memory store with a 30-minute TTL and 100-entry LRU cap.\n' +
      'If a block expires before use, delegate_tasks returns an error identifying the missing id.',
    {
      id: z.string().optional().describe('Optional id; auto-generated UUID if omitted'),
      content: z.string().describe('The content to store'),
    },
    async ({ id, content }) => {
      const result = contextBlockStore.register(content, { id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ contextBlockId: result.id }, null, 2) }],
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
    },
    async ({ batchId, taskIndices }) => {
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

      // Apply auto-escape truncation
      const truncatedResults = truncateResults(
        results.map(r => ({ status: r.status, output: r.output, filesWritten: r.filesWritten, error: r.error })),
        retryBatchId,
        resolvedThreshold,
      );

      return buildUnifiedResponse({
        batchId: retryBatchId,
        results: results.map((r, i) => ({ ...r, output: truncatedResults[i].output })),
        tasks: subset,
        wallClockMs,
        parentModel: resolvedParentModel,
      });
    },
  );

  server.tool(
    'get_batch_slice',
    `Retrieve full telemetry and output data from a previous delegate_tasks batch.

Returns the complete batch with timings, progress, cost breakdown, and all task results.
Optionally filter to a single task via taskIndex.

Batches are cached in memory per MCP server instance with a 30-minute TTL from creation
and a 100-entry LRU cap. Access touches the LRU order but does not refresh TTL. If the
batch is expired or evicted, re-dispatch via delegate_tasks with the full specs.`,
    {
      batchId: z.string().describe('Batch ID from a prior delegate_tasks or retry_tasks response'),
      taskIndex: z.number().int().min(0).optional().describe('0-based task index. Omit for all tasks.'),
    },
    async ({ batchId, taskIndex }) => {
      const entry = batchCache.get(batchId);
      if (!entry || entry.expiresAt < Date.now()) {
        if (entry) batchCache.delete(batchId);
        return {
          content: [{
            type: 'text' as const,
            text: `Batch "${batchId}" is unknown or expired. Batch results are cached for 30 minutes after completion. Re-dispatch the original task to get fresh results.`,
          }],
        };
      }

      touchBatch(batchId, entry);

      if (!entry.results) {
        return {
          content: [{
            type: 'text' as const,
            text: `Batch "${batchId}" has no results yet — the original dispatch may still be running.`,
          }],
        };
      }

      if (taskIndex !== undefined && (taskIndex < 0 || taskIndex >= entry.results.length)) {
        return {
          content: [{
            type: 'text' as const,
            text: `taskIndex ${taskIndex} is out of range. Batch "${batchId}" has ${entry.results.length} tasks (0-based index: 0 to ${entry.results.length - 1}).`,
          }],
        };
      }

      const results = taskIndex !== undefined
        ? [entry.results[taskIndex]]
        : entry.results;

      const wallClockMs = Math.max(0, ...entry.results.map((r) => r.durationMs ?? 0));
      const timings = computeTimings(wallClockMs, entry.results);
      const batchProgress = computeBatchProgress(entry.results);
      const aggregateCost = computeAggregateCost(entry.results);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            batchId,
            timings,
            batchProgress,
            aggregateCost,
            results,
          }, null, 2),
        }],
      };
    },
  );

  registerAuditDocument(server, config, logger, contextBlockStore);
  registerDebugTask(server, config, logger, contextBlockStore);
  registerExecutePlan(server, config, logger, contextBlockStore);
  registerReviewCode(server, config, logger, contextBlockStore);
  registerVerifyWork(server, config, logger, contextBlockStore);

  registerConfirmClarifications(
    server,
    config,
    logger,
    clarificationStore,
    runTasksImpl,
    rememberBatch,
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

let installedLifecycleHandlers: null | {
  stdoutError: (err: NodeJS.ErrnoException) => void;
  stdinEnd: () => void;
  uncaught: (err: Error) => void;
  unhandled: (reason: unknown) => void;
} = null;

/**
 * Install safety nets for the stdio transport lifecycle. The MCP SDK's
 * StdioServerTransport writes every JSON-RPC frame to `process.stdout`
 * but never attaches an error handler to it, so when the Claude Code
 * client closes the read end of our stdout (reconnect, /mcp restart,
 * extension reload, client crash, long-running-call abort) the next
 * write emits an `EPIPE` error with no listener, which Node turns into
 * `uncaughtException` and — absent a handler — terminates the process.
 * That is the observed "MCP dies every ~2 calls" failure mode.
 *
 * Single-install contract: calling this more than once in one process is a
 * programmer error. The healthy-server contract ("one stderr line at startup")
 * covers only the first install. A second call writes a warning to stderr
 * and returns — it does not register duplicate handlers. This warning path is
 * outside the healthy-server contract; in normal operation `main()` is the only
 * caller and is invoked exactly once per process.
 */
export function installStdioLifecycleHandlers(logger: DiagnosticLogger): void {
  if (installedLifecycleHandlers !== null) {
    process.stderr.write('[multi-model-agent] lifecycle handlers already installed; skipping second install\n');
    return;
  }
  const stdoutError = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      logger.shutdown('stdout_epipe', err);
      process.exit(0);
      return;
    }
    logger.shutdown('stdout_other_error', err);
    process.stderr.write(`[multi-model-agent] stdout error: ${err.message}\n`);
    process.exit(1);
  };
  const stdinEnd = () => {
    logger.shutdown('stdin_end');
    process.exit(0);
  };
  const uncaught = (err: Error) => {
    logger.shutdown('uncaughtException', err);
    process.stderr.write(`[multi-model-agent] uncaughtException: ${err.stack ?? String(err)}\n`);
    process.exit(1);
  };
  const unhandled = (reason: unknown) => {
    logger.logError('unhandledRejection', reason);
    const stack = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`[multi-model-agent] unhandledRejection: ${stack}\n`);
  };
  process.stdout.on('error', stdoutError);
  process.stdin.on('end', stdinEnd);
  process.on('uncaughtException', uncaught);
  process.on('unhandledRejection', unhandled);
  installedLifecycleHandlers = { stdoutError, stdinEnd, uncaught, unhandled };
}

/** Test-only. Not exported from the package public surface. */
export function __resetStdioLifecycleHandlersForTests(): void {
  if (installedLifecycleHandlers === null) return;
  process.stdout.off('error', installedLifecycleHandlers.stdoutError);
  process.stdin.off('end', installedLifecycleHandlers.stdinEnd);
  process.off('uncaughtException', installedLifecycleHandlers.uncaught);
  process.off('unhandledRejection', installedLifecycleHandlers.unhandled);
  installedLifecycleHandlers = null;
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

  const logger = createDiagnosticLogger();
  process.stderr.write(`[multi-model-agent] diagnostic log: ${logger.expectedPath()}\n`);
  installStdioLifecycleHandlers(logger);

  const server = buildMcpServer(config, logger);
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
