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
import type { MultiModelConfig, TaskSpec } from '@zhixuan92/multi-model-agent-core';
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
    async ({ tasks }) => {
      const results = await runTasks(tasks as TaskSpec[], config);

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
