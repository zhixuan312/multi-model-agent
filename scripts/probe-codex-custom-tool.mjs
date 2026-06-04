// Test: when @openai/agents serializes a custom tool() factory, does the
// codex backend accept the resulting request? If yes, we can use the SDK's
// Agent + Runner (with its agent loop) and just feed it OUR ToolImplementations
// wrapped as custom tool() — no hosted shell/apply_patch needed.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { Agent, Runner, OpenAIProvider, tool } from '@openai/agents';
import { z } from 'zod';

const raw = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8'));

const realFetch = globalThis.fetch;
let lastBody = null;
globalThis.fetch = async (url, init) => {
  if (init?.body) {
    const body = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
    lastBody = body;
  }
  return realFetch(url, init);
};

const client = new OpenAI({
  apiKey: raw.tokens.access_token,
  baseURL: 'https://chatgpt.com/backend-api/codex',
  defaultHeaders: { 'chatgpt-account-id': raw.tokens.account_id },
});

const readFileTool = tool({
  name: 'read_file',
  description: 'Read a file at the given path.',
  parameters: z.object({ path: z.string().describe('File path') }),
  async execute({ path }) {
    return `fake content of ${path}`;
  },
});

const mp = new OpenAIProvider({ openAIClient: client, useResponses: true });
const agent = new Agent({
  name: 'probe',
  model: 'gpt-5.5',
  instructions: 'Reply with the literal OK.',
  tools: [readFileTool],
  modelSettings: { store: false },
});
const runner = new Runner({ modelProvider: mp });

try {
  const r = await runner.run(agent, 'Reply OK.', { stream: true });
  for await (const _ev of r) { /* drain */ }
  await r.completed;
  console.log('PASS');
  console.log('finalOutput:', String(r.finalOutput ?? '').slice(0, 200));
  console.log('\nRequest body sent to backend:');
  console.log(lastBody?.slice(0, 1500));
} catch (e) {
  console.log('FAIL status=', e.status, 'msg=', e.message);
  console.log('\nRequest body that was rejected:');
  console.log(lastBody?.slice(0, 1500));
}
await mp.close().catch(() => {});
