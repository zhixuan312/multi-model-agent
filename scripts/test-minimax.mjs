#!/usr/bin/env node
// Standalone test: loads ~/.multi-model/config.json, creates the minimax
// provider, and calls .run() directly. Bypasses the MCP server entirely
// so we isolate whether the bug is in the runner/provider or the MCP
// stdio layer.
//
// Usage: node scripts/test-minimax.mjs

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createProvider } from '../packages/core/dist/provider.js';

const configPath = path.join(os.homedir(), '.multi-model', 'config.json');
const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Fill defaults the way loadConfig does — good enough for this smoke test
raw.defaults ??= { maxTurns: 200, timeoutMs: 600_000, tools: 'full' };

console.log('[test-minimax] providers in config:', Object.keys(raw.providers));
const mm = raw.providers.minimax;
console.log('[test-minimax] minimax config keys:', Object.keys(mm));
console.log('[test-minimax] baseUrl:', mm.baseUrl);
console.log('[test-minimax] model:', mm.model);
console.log('[test-minimax] has apiKey:', typeof mm.apiKey, '(length =', mm.apiKey?.length, ')');
console.log('[test-minimax] has apiKeyEnv:', typeof mm.apiKeyEnv);

const provider = createProvider('minimax', raw);
console.log('[test-minimax] provider.config keys:', Object.keys(provider.config));
console.log('[test-minimax] provider.config.apiKey present:', !!provider.config.apiKey);

console.log('\n[test-minimax] calling provider.run("Say hi.") with tools=none ...');
const result = await provider.run('Say hi in one word.', {
  tools: 'none',
  maxTurns: 2,
  timeoutMs: 30_000,
});

console.log('\n[test-minimax] RunResult:');
console.log('  status:', result.status);
console.log('  turns:', result.turns);
console.log('  output:', JSON.stringify(result.output));
if (result.error) console.log('  error:', result.error);
