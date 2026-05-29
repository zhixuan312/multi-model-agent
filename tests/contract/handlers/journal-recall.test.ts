import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from '../fixtures/start-test-server.js';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server: Awaited<ReturnType<typeof startTestServer>>;
let cwd: string;
let token: string;
let url: string;

beforeAll(async () => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'journal-recall-')));
  mkdirSync(join(cwd, 'src/auth'), { recursive: true });
  writeFileSync(join(cwd, 'src/auth/refresh.ts'), '');
  server = await startTestServer({ cwd });
  token = server.token;
  url = `${server.baseUrl}/journal-recall?cwd=${encodeURIComponent(cwd)}`;
});
afterAll(async () => { await server.close(); });

const headers = () => ({ 'x-mma-main-model': 'claude-opus-4-7', 'x-mma-client': 'claude-code', 'authorization': `Bearer ${token}`, 'content-type': 'application/json' });

describe('contract: POST /journal/recall handler-level', () => {
  it('1. POST /journal/recall with valid query (15+ chars) → 202 with batchId', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ query: 'x'.repeat(15) }) });
    expect(r.status).toBe(202);
    const body = await r.json();
    expect(body.batchId).toBeDefined();
    expect(typeof body.batchId).toBe('string');
    expect(body.statusUrl).toBeDefined();
  });

  it('2. POST /journal/recall with query < 15 chars → 400', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ query: 'x' }) });
    expect(r.status).toBe(400);
  });

  it('3. POST /journal/recall with nonexistent contextBlockIds → 400 context_block_not_found', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ query: 'x'.repeat(15), contextBlockIds: ['ghost'] }) });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error.code).toBe('context_block_not_found');
  });
});
