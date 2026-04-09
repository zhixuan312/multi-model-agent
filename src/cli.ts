#!/usr/bin/env node

import fs from 'fs';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createProvider } from './provider.js';
import { delegateAll } from './delegate.js';
import type { MultiModelConfig, DelegateTask } from './types.js';
import { describeProviders } from './routing/describe.js';

export const SERVER_NAME = 'multi-model-agent';
export const SERVER_VERSION = '0.1.0';

export function buildTaskSchema(availableProviders: [string, ...string[]]) {
  return z.object({
    prompt: z.string().describe('Task prompt for the sub-agent'),
    provider: z.enum(availableProviders).describe('Provider name'),
    tier: z.enum(['trivial', 'standard', 'reasoning'])
      .describe('Required quality tier. See the routing recipe in this tool description — match the task to a provider that meets this tier.'),
    requiredCapabilities: z.array(z.enum([
      'file_read', 'file_write', 'grep', 'glob',
      'shell', 'web_search', 'web_fetch',
    ])).describe('Capabilities this task requires. Empty array if none. Consumer LLM MUST exclude providers missing any required capability.'),
    tools: z.enum(['none', 'full']).optional().describe('Tool access mode. Default: full'),
    maxTurns: z.number().int().positive().optional().describe('Max agent loop turns. Default: 200'),
    timeoutMs: z.number().int().positive().optional().describe('Timeout in ms. Default: 600000'),
    cwd: z.string().optional().describe('Working directory for file/shell tools'),
    effort: z.string().optional().describe('Reasoning effort level'),
    sandboxPolicy: z.enum(['none', 'cwd-only']).optional().describe('File-system confinement policy. Default: cwd-only'),
  });
}

export function buildMcpServer(config: MultiModelConfig) {
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
    describeProviders(config),
    {
      tasks: z.array(buildTaskSchema(availableProviders)).describe('Array of tasks to execute in parallel'),
    },
    async ({ tasks }) => {
      const delegateTasks: DelegateTask[] = tasks.map(t => {
        const provider = createProvider(t.provider, config);
        return {
          provider,
          prompt: t.prompt,
          tier: t.tier,
          requiredCapabilities: t.requiredCapabilities,
          tools: t.tools,
          maxTurns: t.maxTurns,
          timeoutMs: t.timeoutMs,
          cwd: t.cwd,
          effort: t.effort,
          sandboxPolicy: t.sandboxPolicy,
        };
      });

      const results = await delegateAll(delegateTasks);

      const response = {
        results: results.map((r, i) => ({
          provider: tasks[i].provider,
          status: r.status,
          output: r.output,
          turns: r.turns,
          files: r.files,
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

async function main() {
  const args = process.argv.slice(2);

  if (args[0] !== 'serve') {
    console.error('Usage: multi-model-agent serve [--config <path>]');
    process.exit(1);
  }

  const configFlagIdx = args.indexOf('--config');
  const configPath = configFlagIdx >= 0 ? args[configFlagIdx + 1] : undefined;

  const config = loadConfig(configPath);
  const providerNames = Object.keys(config.providers);

  if (providerNames.length === 0) {
    console.error('No providers configured. Create ~/.multi-model/config.json or pass --config <path>.');
    process.exit(1);
  }

  const server = buildMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run main when executed directly (not imported)
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
