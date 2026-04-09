import fs from 'fs';
import path from 'path';
import os from 'os';
import { z } from 'zod';
import type { MultiModelConfig } from './types.js';

const providerConfigSchema = z.object({
  type: z.enum(['codex', 'claude', 'openai-compatible']),
  model: z.string(),
  effort: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  sandboxPolicy: z.enum(['none', 'cwd-only']).optional(),
  hostedTools: z.array(z.enum(['web_search', 'image_generation', 'code_interpreter'])).optional(),
});

const configSchema = z.object({
  providers: z.record(z.string(), providerConfigSchema).default({}),
  defaults: z.object({
    maxTurns: z.number().int().positive().default(200),
    timeoutMs: z.number().int().positive().default(600_000),
    tools: z.enum(['none', 'full']).default('full'),
  }).default(() => ({ maxTurns: 200, timeoutMs: 600_000, tools: 'full' as const })),
});

const CONFIG_SEARCH_PATHS = [
  path.join(os.homedir(), '.multi-model', 'config.json'),
];

export function loadConfig(configPath?: string): MultiModelConfig {
  // Explicit path
  if (configPath) {
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return configSchema.parse(raw);
  }

  // Env var
  const envPath = process.env.MULTI_MODEL_CONFIG;
  if (envPath) {
    if (!fs.existsSync(envPath)) {
      throw new Error(`Config file not found (MULTI_MODEL_CONFIG): ${envPath}`);
    }
    const raw = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
    return configSchema.parse(raw);
  }

  // Search paths
  for (const searchPath of CONFIG_SEARCH_PATHS) {
    if (fs.existsSync(searchPath)) {
      const raw = JSON.parse(fs.readFileSync(searchPath, 'utf-8'));
      return configSchema.parse(raw);
    }
  }

  // No config found — return defaults
  return configSchema.parse({});
}
