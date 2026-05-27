import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from '../fixtures/start-test-server.js';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server: Awaited<ReturnType<typeof startTestServer>>;
let cwd: string;
let token: string;
let url: string;

beforeAll(async () => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'research-')));
  server = await startTestServer({ cwd });
  token = server.token;
  url = `${server.baseUrl}/research?cwd=${encodeURIComponent(cwd)}`;
});
afterAll(async () => { await server.close(); });

const headers = () => ({
  'x-mma-main-model': 'claude-opus-4-7',
  'x-mma-client': 'claude-code',
  'authorization': `Bearer ${token}`,
  'content-type': 'application/json',
});

const validBody = {
  researchQuestion: 'What approaches exist for SIMD JSON parsing in 2025?',
  background: 'We currently use a single-pass push parser and want SIMD alternatives.',
};

describe('contract: POST /research handler-level (schema validation)', () => {
  it('rejects unknown field anchors → 400', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...validBody, anchors: ['/foo'] }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects agentType → 400', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...validBody, agentType: 'simple' }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects tools field → 400', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...validBody, tools: 'full' }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects researchQuestion shorter than 20 chars → 400', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...validBody, researchQuestion: 'too short' }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects background shorter than 20 chars → 400', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...validBody, background: 'short' }),
    });
    expect(r.status).toBe(400);
  });

  it('accepts valid body (status is 202 dispatch or 503 if dispatcher not configured)', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(validBody) });
    expect([202, 503]).toContain(r.status);
    if (r.status === 202) {
      const body = await r.json();
      expect(body.batchId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
