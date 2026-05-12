// Probe: does the codex backend accept @openai/agents' request shape
// when configured with the SDK's HOSTED tools (shellTool + applyPatchTool)?
//
// This is the deciding test for v4.4 codex: if 200, codex can use the same
// thin wrapper as OpenAI proper (option 2). If 400, the backend rejects
// @openai/agents at the envelope level and we need a custom adapter
// (option 1).
//
// Run: node scripts/probe-codex-hosted-tools.mjs

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { Agent, Runner, OpenAIProvider, shellTool, applyPatchTool } from '@openai/agents';

// --- 1. Load codex OAuth ---
const authPath = join(homedir(), '.codex', 'auth.json');
const raw = JSON.parse(readFileSync(authPath, 'utf8'));
const accessToken = raw.tokens?.access_token;
const accountId = raw.tokens?.account_id;
if (!accessToken || !accountId) {
  console.error('FAIL: missing tokens in', authPath);
  process.exit(1);
}
console.log('Loaded codex OAuth. accountId =', accountId.slice(0, 8) + '…');

// --- 2. Build OpenAI client pointed at codex backend ---
const client = new OpenAI({
  apiKey: accessToken,
  baseURL: 'https://chatgpt.com/backend-api/codex',
  defaultHeaders: { 'chatgpt-account-id': accountId },
});

// --- 3. Build hosted tools ---
const shell = shellTool({
  shell: async (cmd) => {
    console.log('  [shell impl invoked]', cmd);
    return { stdout: 'OK', stderr: '', exitCode: 0 };
  },
});

const editor = applyPatchTool({
  editor: {
    async apply(_patch) {
      console.log('  [editor impl invoked]');
      return { ok: true };
    },
  },
});

console.log('Tools:', shell.name, '(' + shell.type + '),', editor.name, '(' + editor.type + ')');

// --- 4. Build agent + runner ---
const modelProvider = new OpenAIProvider({ openAIClient: client, useResponses: true });
const agent = new Agent({
  name: 'probe',
  model: 'gpt-5.5',
  instructions: 'You are a probe. Reply with the literal string OK and nothing else.',
  tools: [shell, editor],
  modelSettings: { store: false },
});
const runner = new Runner({ modelProvider });

// --- 5. Run ---
const t0 = Date.now();
try {
  const result = await runner.run(agent, 'Say OK.');
  const dt = Date.now() - t0;
  console.log(`PASS in ${dt}ms`);
  console.log('finalOutput:', String(result.finalOutput ?? '').slice(0, 200));
  console.log('result keys:', Object.keys(result));
  await modelProvider.close();
  process.exit(0);
} catch (err) {
  const dt = Date.now() - t0;
  console.error(`FAIL in ${dt}ms`);
  console.error('  name:', err?.name);
  console.error('  status:', err?.status);
  console.error('  message:', err?.message);
  if (err?.response) {
    try { console.error('  response body:', await err.response.text()); } catch {}
  }
  console.error('  stack:', String(err?.stack || '').split('\n').slice(0, 5).join('\n'));
  await modelProvider.close().catch(() => {});
  process.exit(2);
}
