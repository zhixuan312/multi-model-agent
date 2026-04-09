#!/usr/bin/env node
// Standalone test: calls runCodex directly and dumps the full RunResult.
// Usage: CODEX_DEBUG=1 node scripts/test-codex.mjs
import { runCodex } from '../dist/runners/codex-runner.js';

const providerConfig = {
  type: 'codex',
  model: 'gpt-5.4',
};

const defaults = {
  maxTurns: 10,
  timeoutMs: 120_000,
  tools: 'none',
};

console.log('[test-codex] calling runCodex with prompt "Say hi."');
console.log('[test-codex] CODEX_DEBUG =', process.env.CODEX_DEBUG ?? '(unset)');

const result = await runCodex(
  'Say hi.',
  { tools: 'none' },
  providerConfig,
  defaults,
);

console.log('\n[test-codex] RunResult:');
console.log(JSON.stringify(result, null, 2));

console.log('\n[test-codex] output length:', result.output.length);
console.log('[test-codex] output (literal):', JSON.stringify(result.output));
