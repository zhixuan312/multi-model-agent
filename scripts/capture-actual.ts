import { boot } from '../tests/contract/fixtures/harness.js';
import { mockProvider } from '../tests/contract/fixtures/mock-providers.js';
import { normalize } from '../tests/contract/serializer/normalize.js';

async function pollToTerminal(baseUrl: string, token: string, batchId: string) {
  for (let i = 0; i < 180; i++) {
    const poll = await fetch(`${baseUrl}/batch/${batchId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (poll.status === 200) return await poll.json();
    if (poll.status !== 202) throw new Error(`Unexpected status ${poll.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout ${batchId}`);
}

async function main() {
  const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
  try {
    const dispatch = await fetch(`${h.baseUrl}/audit?cwd=${encodeURIComponent(process.cwd())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
      body: JSON.stringify({ document: 'function add(a, b) { return a + b; }', auditType: 'general' }),
    });
    const { batchId } = await dispatch.json() as { batchId: string };
    const terminal = await pollToTerminal(h.baseUrl, h.token, batchId);
    const actual = normalize(terminal);
    process.stdout.write(JSON.stringify(actual, null, 2) + '\n');
  } finally {
    await h.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
