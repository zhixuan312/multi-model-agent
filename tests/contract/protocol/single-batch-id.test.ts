import { startTestServer, type TestServer } from '../../helpers/test-server.js';

async function pollToTerminal(server: TestServer, batchId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${server.url}/batch/${batchId}`, { headers: { 'X-MMA-Main-Model': 'claude-opus-4-7', 'X-MMA-Client': 'claude-code', 'Authorization': `Bearer ${server.token}` } });
    if (r.status === 200 && r.headers.get('content-type')?.includes('application/json')) {
      return await r.json() as Record<string, unknown>;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`poll timeout for batch ${batchId}`);
}

describe('single batchId namespace (T4)', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({
      agents: {
        standard: { type: 'codex', baseUrl: 'http://mock.local', apiKey: 'stub', model: 'mock' },
        complex: { type: 'codex', baseUrl: 'http://mock.local', apiKey: 'stub', model: 'mock' },
      },
      defaults: { tools: 'none', timeoutMs: 30_000, sandboxPolicy: 'cwd-only' },
    } as never);
  });
  afterAll(async () => { await server.stop(); });

  it('/retry accepts the same batchId returned by /delegate', async () => {
    const dispatch = await fetch(`${server.url}/delegate?cwd=${process.cwd()}`, {
      method: 'POST', headers: { 'X-MMA-Main-Model': 'claude-opus-4-7', 'X-MMA-Client': 'claude-code', 'Authorization': `Bearer ${server.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: [{ prompt: 'echo hi' }] })
    });
    expect(dispatch.status).toBe(202);
    const { batchId } = await dispatch.json() as { batchId: string };
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/);
    const term = await pollToTerminal(server, batchId);
    expect(term.batchId).toBe(batchId);
    const retry = await fetch(`${server.url}/control/retry?cwd=${process.cwd()}`, {
      method: 'POST', headers: { 'X-MMA-Main-Model': 'claude-opus-4-7', 'X-MMA-Client': 'claude-code', 'Authorization': `Bearer ${server.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId, taskIndices: [0] })
    });
    expect(retry.status).not.toBe(404);
  }, 45_000);
});
