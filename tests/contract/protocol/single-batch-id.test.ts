import { startTestServer, type TestServer } from '../../helpers/test-server.js';

describe('single batchId namespace (T4)', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({
      agents: [],
      defaults: { tools: 'none', timeoutMs: 30_000, maxCostUSD: 1, sandboxPolicy: 'cwd-only' },
    } as never);
  });
  afterAll(async () => { await server.stop(); });

  it('/retry accepts the same batchId returned by /delegate', async () => {
    const dispatch = await fetch(`${server.url}/delegate?cwd=${process.cwd()}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${server.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: [{ prompt: 'echo hi' }] })
    });
    expect(dispatch.status).toBe(202);
    const { batchId } = await dispatch.json();
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/);
    // Poll until terminal — 200 with application/json is the terminal marker per spec;
    // 202 with text/plain is "still running" (not JSON). Skip false-positives.
    let term;
    for (let i = 0; i < 120; i++) {
      const r = await fetch(`${server.url}/batch/${batchId}`, { headers: { 'Authorization': `Bearer ${server.token}` } });
      if (r.status === 200 && r.headers.get('content-type')?.includes('application/json')) {
        term = await r.json();
        break;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    expect(term).toBeDefined();
    expect(term.batchId).toBe(batchId);  // confirms terminal envelope echoes the same id
    // Now retry with the SAME id
    const retry = await fetch(`${server.url}/retry?cwd=${process.cwd()}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${server.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId, taskIndices: [0] })
    });
    expect(retry.status).not.toBe(404);
  });
});
