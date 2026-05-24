import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from '../fixtures/start-test-server.js';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server: Awaited<ReturnType<typeof startTestServer>>;
let cwd: string;
let token: string;
let url: string;

beforeAll(async () => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'journal-')));
  mkdirSync(join(cwd, 'src/auth'), { recursive: true });
  writeFileSync(join(cwd, 'src/auth/refresh.ts'), '');
  server = await startTestServer({ cwd });
  token = server.token;
  url = `${server.baseUrl}/journal-record?cwd=${encodeURIComponent(cwd)}`;
});
afterAll(async () => { await server.close(); });

const headers = () => ({ 'x-mma-main-model': 'claude-opus-4-7', 'x-mma-client': 'claude-code', 'authorization': `Bearer ${token}`, 'content-type': 'application/json' });

describe('contract: POST /journal handler-level', () => {
  it('1. valid { learning, tagHints } → 202 with batchId', async () => {
    const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ learning: 'x'.repeat(25), tagHints: ['journal'] }) });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(typeof body.batchId).toBe('string');
  });

  it('2. learning too short → 400 invalid_request', async () => {
    const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ learning: 'short' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
  });

  it('3. extra bogus field → 400 (strict schema)', async () => {
    const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ learning: 'x'.repeat(25), bogus: 1 }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
  });
});
