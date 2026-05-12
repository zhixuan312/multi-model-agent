// Test which tool envelopes the codex backend accepts.
// Hits the responses endpoint directly (no @openai/agents) so we know
// exactly what we sent.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';

const raw = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8'));
const client = new OpenAI({
  apiKey: raw.tokens.access_token,
  baseURL: 'https://chatgpt.com/backend-api/codex',
  defaultHeaders: { 'chatgpt-account-id': raw.tokens.account_id },
});

async function probe(label, body) {
  process.stdout.write(`\n[${label}] `);
  try {
    const stream = await client.responses.create(body);
    let dt = Date.now();
    let firstEvent = null;
    let count = 0;
    for await (const ev of stream) {
      if (!firstEvent) firstEvent = ev.type;
      count++;
      if (count > 200) break;
    }
    console.log(`PASS  firstEvent=${firstEvent} events=${count} (${Date.now() - dt}ms)`);
  } catch (e) {
    const body = await e?.response?.text?.().catch(() => null);
    console.log(`FAIL  status=${e.status}  body=${body ?? e.message}`);
  }
}

const base = {
  model: 'gpt-5.5',
  instructions: 'Reply OK.',
  input: [{ role: 'user', content: 'Say OK.' }],
  stream: true,
  store: false,
};

// 1. No tools at all
await probe('no-tools', { ...base, tools: [] });

// 2. Hosted apply_patch only
await probe('hosted-apply_patch', { ...base, tools: [{ type: 'apply_patch' }] });

// 3. Hosted shell only
await probe('hosted-shell', { ...base, tools: [{ type: 'shell', environment: { type: 'local' } }] });

// 4. Function tool (3.12.7 format)
await probe('function-tool', {
  ...base,
  tools: [{
    type: 'function',
    name: 'read_file',
    description: 'Read a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    strict: false,
  }],
});

// 5. Function tool + apply_patch combined
await probe('function+apply_patch', {
  ...base,
  tools: [
    { type: 'apply_patch' },
    {
      type: 'function',
      name: 'read_file',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      strict: false,
    },
  ],
});

// 6. Local shell (codex CLI's canonical type)
await probe('local_shell', { ...base, tools: [{ type: 'local_shell' }] });
