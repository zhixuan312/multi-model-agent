#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfigFromFile } from '@zhixuan92/multi-model-agent-core/config/load';
import { parseConfig } from '@zhixuan92/multi-model-agent-core/config/schema';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import type {
  MultiModelConfig,
  TaskSpec,
  ProgressEvent,
} from '@zhixuan92/multi-model-agent-core';
import { renderProviderRoutingMatrix } from './routing/render-provider-routing-matrix.js';

export const SERVER_NAME = 'multi-model-agent';
export const SERVER_VERSION = '0.1.0';

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
  });
}

export function buildMcpServer(config: Parameters<typeof runTasks>[1]) {
  const providerKeys = Object.keys(config.providers);
  if (providerKeys.length === 0) {
    throw new Error('buildMcpServer requires at least one configured provider.');
  }

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const availableProviders = providerKeys as [string, ...string[]];

  server.tool(
    'delegate_tasks',
    renderProviderRoutingMatrix(config),
    {
      tasks: z.array(buildTaskSchema(availableProviders)).describe('Array of tasks to execute in parallel'),
    },
    async ({ tasks }, extra) => {
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
      const progressToken = extra._meta?.progressToken as
        | string
        | number
        | undefined;

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

      const results = await runTasks(tasks as TaskSpec[], config, {
        onProgress: sendProgress,
      });

      const response = {
        results: results.map((r, i) => ({
          provider: tasks[i].provider ?? '(auto)',
          status: r.status,
          output: r.output,
          turns: r.turns,
          filesRead: r.filesRead,
          filesWritten: r.filesWritten,
          toolCalls: r.toolCalls,
          escalationLog: r.escalationLog,
          usage: r.usage,
          ...(r.error && { error: r.error }),
        })),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
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
