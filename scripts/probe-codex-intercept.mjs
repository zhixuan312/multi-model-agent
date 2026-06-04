// Intercept the request @openai/agents builds for codex to understand the 400.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { Agent, Runner, OpenAIProvider, shellTool, applyPatchTool } from '@openai/agents';

const raw = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8'));
const accessToken = raw.tokens.access_token;
const accountId = raw.tokens.account_id;

// Wrap fetch globally to capture request + response
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  console.log('\n--- OUTGOING REQUEST ---');
  console.log('URL:', url);
  console.log('method:', init?.method);
  console.log('headers:', Object.fromEntries(Object.entries(init?.headers ?? {})));
  if (init?.body) {
    try {
      const body = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
      console.log('body (first 4KB):', body.slice(0, 4000));
      console.log('body length:', body.length);
    } catch (e) { console.log('body read failed:', e.message); }
  }
  const resp = await realFetch(url, init);
  console.log('\n--- INCOMING RESPONSE ---');
  console.log('status:', resp.status);
  console.log('headers:', Object.fromEntries(resp.headers.entries()));
  // Tee response body
  const clone = resp.clone();
  try {
    const text = await clone.text();
    console.log('body (first 4KB):', text.slice(0, 4000));
  } catch (e) { console.log('body read failed:', e.message); }
  return resp;
};

const client = new OpenAI({
  apiKey: accessToken,
  baseURL: 'https://chatgpt.com/backend-api/codex',
  defaultHeaders: { 'chatgpt-account-id': accountId },
});

const shell = shellTool({ shell: async () => ({ stdout: '', stderr: '', exitCode: 0 }) });
const editor = applyPatchTool({ editor: { async apply() { return { ok: true }; } } });

const modelProvider = new OpenAIProvider({ openAIClient: client, useResponses: true });
const agent = new Agent({
  name: 'probe',
  model: 'gpt-5.5',
  instructions: 'Reply OK.',
  tools: [shell, editor],
  modelSettings: { store: false },
});
const runner = new Runner({ modelProvider });

try {
  const r = await runner.run(agent, 'Say OK.', { stream: true });
  // Consume the stream so the run completes
  for await (const _ev of r) { /* drain */ }
  await r.completed;
  console.log('\nFINAL:', String(r.finalOutput ?? ''));
} catch (e) {
  console.log('\nCAUGHT:', e.status, e.message);
}
await modelProvider.close().catch(() => {});
