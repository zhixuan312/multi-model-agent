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
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'invest-')));
  mkdirSync(join(cwd, 'src/auth'), { recursive: true });
  writeFileSync(join(cwd, 'src/auth/refresh.ts'), '');
  server = await startTestServer({ cwd });
  token = server.token;
  url = `${server.baseUrl}/investigate?cwd=${encodeURIComponent(cwd)}`;
});
afterAll(async () => { await server.close(); });

const headers = () => ({ 'authorization': `Bearer ${token}`, 'content-type': 'application/json' });

describe('contract: POST /investigate handler-level', () => {
  it('1. POST /investigate without cwd → 400', async () => {
    const r = await fetch(`${server.baseUrl}/investigate`, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'q' }) });
    expect(r.status).toBe(400);
  });

  it('2. POST /investigate?cwd=<out-of-scope> → 403', async () => {
    // Use a real directory that exists but is not in the test server's allowed scope.
    // Using a nonexistent path conflates "out of scope" (403) with "missing" (could be 400/500).
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'oos-')));
    const r = await fetch(`${server.baseUrl}/investigate?cwd=${encodeURIComponent(outside)}`, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'q' }) });
    expect(r.status).toBe(403);
  });

  it('3. tools=full → 400 with fieldErrors.tools', async () => {
    // Existing handlers (audit.ts, etc.) call sendError(res, 400, 'invalid_request', ..., { fieldErrors: parsed.error.flatten() }).
    // `flatten()` produces { formErrors: [], fieldErrors: { ... } } — so the tools key lives at
    // body.details.fieldErrors.fieldErrors.tools. Match this exact shape; do not accept multiple shapes.
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'q', tools: 'full' }) });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body).toMatchObject({ error: 'invalid_request' });
    expect(body.details?.fieldErrors?.fieldErrors?.tools).toEqual(expect.arrayContaining([expect.stringMatching(/only tools 'none' or 'readonly'/)]));
  });

  it('4. tools=no-shell → 400', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'q', tools: 'no-shell' }) });
    expect(r.status).toBe(400);
  });

  it('5. tools=none → 202', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'q', tools: 'none' }) });
    expect(r.status).toBe(202);
  });

  it('6. no tools field → 202 (default readonly)', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'q' }) });
    expect(r.status).toBe(202);
  });

  it('7. agentType=standard → 400 (agentType removed from schema)', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'q', agentType: 'standard' }) });
    expect(r.status).toBe(400);
  });

  it('8. contextBlockIds=[nonexistent] → 400 context_block_not_found', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'q', contextBlockIds: ['ghost'] }) });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('context_block_not_found');
  });

  it('9. empty question → 400 invalid_request', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ question: '   ' }) });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_request');
  });

  it('10. filePaths escape via .. → 400 with fieldErrors.filePaths', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'q', filePaths: ['../outside'] }) });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_request');
    expect(body.details?.fieldErrors?.filePaths).toEqual(['../outside']);
  });

  it('11. path-boundary safe (cwd=/X/app does not accept /X/app2/y)', async () => {
    // CRITICAL: this case must run against a server scoped to root/app, not the
    // module-level `cwd`. If we POST to a server scoped to a different cwd, the
    // request would 403 on cwd-scope check before ever reaching canonicalizeFilePaths,
    // and the test would mis-validate.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pb-')));
    mkdirSync(join(root, 'app'));
    mkdirSync(join(root, 'app2'));
    writeFileSync(join(root, 'app2/y.ts'), '');
    const altServer = await startTestServer({ cwd: join(root, 'app') });
    try {
      const url2 = `${altServer.baseUrl}/investigate?cwd=${encodeURIComponent(join(root, 'app'))}`;
      const r = await fetch(url2, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${altServer.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'q', filePaths: [join(root, 'app2/y.ts')] }),
      });
      expect(r.status).toBe(400);
      const body = await r.json();
      expect(body.error).toBe('invalid_request');
      expect(body.details?.fieldErrors?.filePaths).toBeTruthy();
    } finally {
      await altServer.close();
    }
  });

  it('12. symlink escape detected even when target file does not exist', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'out-')));
    mkdirSync(join(cwd, 'src/sym-parent'), { recursive: true });
    symlinkSync(outside, join(cwd, 'src/sym-parent/escape'));
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'q', filePaths: ['src/sym-parent/escape/missing.ts'] }) });
    expect(r.status).toBe(400);
  });

  it('13. duplicates dedup after canonicalization → 202', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'q', filePaths: ['./src/auth/', 'src/auth'] }) });
    expect(r.status).toBe(202);
  });

  it('14. nonexistent file inside cwd → 202; prompt uses relative path', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'q', filePaths: ['src/new-file.ts'] }) });
    expect(r.status).toBe(202);
    // The relative-prompt assertion is exercised in the reviewed-execution test 35.
  });

  it('15. timeoutMs at top level → 400 invalid_request (strict schema)', async () => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ question: 'q', timeoutMs: 60000 }) });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_request');
  });
});
