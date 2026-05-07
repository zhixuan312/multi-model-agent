import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from '../fixtures/start-test-server.js';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server: Awaited<ReturnType<typeof startTestServer>>;
let cwd: string;
let token: string;
let url: string;

beforeAll(async () => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'explore-')));
  mkdirSync(join(cwd, 'src/auth'), { recursive: true });
  writeFileSync(join(cwd, 'src/auth/refresh.ts'), '');
  server = await startTestServer({ cwd });
  token = server.token;
  url = `${server.baseUrl}/explore?cwd=${encodeURIComponent(cwd)}`;
});
afterAll(async () => { await server.close(); });

const headers = () => ({ 'x-mma-main-model': 'claude-opus-4-7', 'x-mma-client': 'claude-code', 'authorization': `Bearer ${token}`, 'content-type': 'application/json' });

describe('contract: POST /explore handler-level', () => {
  it('1. POST /explore without cwd → 400', async () => {
    const r = await fetch(`${server.baseUrl}/explore`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: 'a'.repeat(20), explorationQuestion: 'b'.repeat(20) }),
    });
    expect(r.status).toBe(400);
  });

  it('2. POST /explore?cwd=<out-of-scope> → 403', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'oos-')));
    const r = await fetch(`${server.baseUrl}/explore?cwd=${encodeURIComponent(outside)}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: 'a'.repeat(20), explorationQuestion: 'b'.repeat(20) }),
    });
    expect(r.status).toBe(403);
  });

  it('3. agentType → 400 with tier_not_overridable', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: 'a'.repeat(20), explorationQuestion: 'b'.repeat(20), agentType: 'simple' }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body).toMatchObject({ error: 'invalid_request' });
    expect(body.details?.fieldErrors?.fieldErrors?.agentType).toEqual(
      expect.arrayContaining([expect.stringMatching(/tier_not_overridable/)]),
    );
  });

  it('4. tools → 400 with tool_surface_not_overridable', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: 'a'.repeat(20), explorationQuestion: 'b'.repeat(20), tools: 'full' }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body).toMatchObject({ error: 'invalid_request' });
    expect(body.details?.fieldErrors?.fieldErrors?.tools).toEqual(
      expect.arrayContaining([expect.stringMatching(/tool_surface_not_overridable/)]),
    );
  });

  it('5. missing currentContext → 400', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ explorationQuestion: 'b'.repeat(20) }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_request');
  });

  it('6. missing explorationQuestion → 400', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: 'a'.repeat(20) }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_request');
  });

  it('7. empty currentContext → 400', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: '   ', explorationQuestion: 'b'.repeat(20) }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_request');
  });

  it('8. empty explorationQuestion → 400', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: 'a'.repeat(20), explorationQuestion: '   ' }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_request');
  });

  it('9. contextBlockIds=[nonexistent] → 400 context_block_not_found', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: 'a'.repeat(20), explorationQuestion: 'b'.repeat(20), contextBlockIds: ['ghost'] }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('context_block_not_found');
  });

  it('10. anchors escape via .. → 400 with fieldErrors', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: 'a'.repeat(20), explorationQuestion: 'b'.repeat(20), anchors: ['../outside'] }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_request');
    expect(body.details?.fieldErrors?.filePaths).toEqual(['../outside']);
  });

  it('11. symlink anchor escape detected', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'out-')));
    mkdirSync(join(cwd, 'src/sym-parent'), { recursive: true });
    symlinkSync(outside, join(cwd, 'src/sym-parent/escape'));
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: 'a'.repeat(20), explorationQuestion: 'b'.repeat(20), anchors: ['src/sym-parent/escape/missing.ts'] }),
    });
    expect(r.status).toBe(400);
  });

  it('12. duplicate anchors dedup after canonicalization → 202', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: 'a'.repeat(20), explorationQuestion: 'b'.repeat(20), anchors: ['./src/auth/', 'src/auth'] }),
    });
    expect(r.status).toBe(202);
  });

  it('13. nonexistent anchor inside cwd → 202', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: 'a'.repeat(20), explorationQuestion: 'b'.repeat(20), anchors: ['src/new-file.ts'] }),
    });
    expect(r.status).toBe(202);
  });

  it('14. unknown field → 400', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: 'a'.repeat(20), explorationQuestion: 'b'.repeat(20), extraField: true }),
    });
    expect(r.status).toBe(400);
  });

  it('15. happy path returns 202 with batchId and statusUrl', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ currentContext: 'a'.repeat(20), explorationQuestion: 'b'.repeat(20) }),
    });
    expect(r.status).toBe(202);
    const body = await r.json() as { batchId?: string; statusUrl?: string };
    expect(body.batchId).toMatch(/^[a-f0-9-]+$/);
    expect(body.statusUrl).toMatch(/^\/batch\/[a-f0-9-]+$/);
  });

  it('16. happy path with valid anchors and contextBlockIds → 202', async () => {
    // Register a context block first, then pass its id
    const blockResp = await fetch(`${server.baseUrl}/context-blocks?cwd=${encodeURIComponent(cwd)}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ content: 'test block', label: 'test' }),
    });
    expect(blockResp.status).toBe(201);
    const block = await blockResp.json() as { id?: string };
    expect(block.id).toBeTruthy();

    const r = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        currentContext: 'a'.repeat(20),
        explorationQuestion: 'b'.repeat(20),
        anchors: ['src/auth/refresh.ts'],
        contextBlockIds: [block.id],
      }),
    });
    expect(r.status).toBe(202);
    const body = await r.json() as { batchId?: string; statusUrl?: string };
    expect(body.batchId).toMatch(/^[a-f0-9-]+$/);
    expect(body.statusUrl).toMatch(/^\/batch\/[a-f0-9-]+$/);
  });
});
