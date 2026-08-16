import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

// Spawn-free codex verification for this file — see the module for why it is per-file.
import '../helpers/stub-codex-binary.js';


let mockApi: Server;
let mockApiPort: number;

beforeAll(async () => {
  mockApi = createServer((req, res) => {
    const auth = req.headers['authorization'] ?? req.headers['x-api-key'];
    if (!auth || auth === 'bad-key' || auth === 'Bearer bad-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'claude-opus-4-8' }, { id: 'claude-sonnet-4-6' },
          { id: 'deepseek-v4-flash' }, { id: 'MiniMax-M3' }, { id: 'gpt-5' },
        ],
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    mockApi.listen(0, '127.0.0.1', () => {
      mockApiPort = (mockApi.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockApi.close(() => resolve()));
});

function mockBaseUrl(): string {
  return `http://127.0.0.1:${mockApiPort}`;
}

function post(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/configure-provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('POST /configure-provider probe (always on)', () => {

  it('valid key + model listed → reachable + modelListed', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'claude-opus-4-8',
        auth: { mode: 'api-key', apiKey: 'good-key', baseUrl: mockBaseUrl() },
      });
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.probe.reachable).toBe(true);
      expect(body.probe.modelListed).toBe(true);
    } finally { await h.close(); }
  });

  it('valid key + model NOT in list → verified false', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'gpt-5.5-pro',
        auth: { mode: 'api-key', apiKey: 'good-key', baseUrl: mockBaseUrl() },
      });
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.probe.reachable).toBe(true);
      expect(body.probe.modelListed).toBe(false);
      expect(body.reason).toMatch(/not listed/i);
    } finally { await h.close(); }
  });

  it('codex tier with the codex CLI absent → verified false (ISSUE-11: verify probes the runner, not just creds)', async () => {
    // The runner spawns `MMA_CODEX_BIN ?? "codex"`; point it at a path that does not exist so the probe
    // ENOENTs. Verification must fail — otherwise the tier is green in the UI but dies on the first task
    // with `codex_not_installed`.
    const prev = process.env.MMA_CODEX_BIN;
    process.env.MMA_CODEX_BIN = '/nonexistent/codex-cli-xyz';
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'complex', provider: 'codex', model: 'gpt-5',
        auth: { mode: 'api-key', apiKey: 'good-key', baseUrl: mockBaseUrl() },
      });
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.reason).toMatch(/codex CLI not found/i);
    } finally {
      await h.close();
      if (prev === undefined) delete process.env.MMA_CODEX_BIN; else process.env.MMA_CODEX_BIN = prev;
    }
  });

  it('bad key → auth rejected', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'gpt-5',
        auth: { mode: 'api-key', apiKey: 'bad-key', baseUrl: mockBaseUrl() },
      });
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.probe.reachable).toBe(false);
      expect(body.probe.detail).toMatch(/401/);
    } finally { await h.close(); }
  });

  it('unreachable endpoint → connection failed', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'gpt-5',
        auth: { mode: 'api-key', apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:19999' },
      });
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.probe.reachable).toBe(false);
    } finally { await h.close(); }
  });

  it('static validation fails → probe skipped (no probe field)', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'gpt-5',
        auth: { mode: 'api-key', apiKey: 'sk-test' },
      });
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.probe).toBeUndefined();
    } finally { await h.close(); }
  });

  it('deepseek model found via probe', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'complex', provider: 'codex', model: 'deepseek-v4-flash',
        auth: { mode: 'api-key', apiKey: 'good-key', baseUrl: mockBaseUrl() },
      });
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.probe.reachable).toBe(true);
      expect(body.probe.modelListed).toBe(true);
    } finally { await h.close(); }
  });

  it('MiniMax-M3 found via probe', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'MiniMax-M3',
        auth: { mode: 'api-key', apiKey: 'good-key', baseUrl: mockBaseUrl() },
      });
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.probe.reachable).toBe(true);
      expect(body.probe.modelListed).toBe(true);
    } finally { await h.close(); }
  });

  it('dryRun=false + probe pass → applied', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'claude-sonnet-4-6',
        auth: { mode: 'api-key', apiKey: 'good-key', baseUrl: mockBaseUrl() },
        dryRun: false,
      });
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.applied).toBe(true);
      expect(body.probe.reachable).toBe(true);
    } finally { await h.close(); }
  });

  it('dryRun=false + probe fail → not applied', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'gpt-5',
        auth: { mode: 'api-key', apiKey: 'bad-key', baseUrl: mockBaseUrl() },
        dryRun: false,
      });
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.applied).toBe(false);
    } finally { await h.close(); }
  });

  /**
   * OAuth verification depends on whether the MACHINE running the suite has Claude
   * subscription credentials, so the outcome legitimately differs between developers and CI.
   * This used to handle that by asserting `typeof verified === 'boolean'` and putting its only
   * real check behind `if (body.probe)` — which on a machine with no OAuth token asserts
   * nothing at all, under a title claiming the probe uses that token.
   *
   * What holds in BOTH environments is the response's internal consistency, and that is what is
   * asserted here: a verified oauth tier reached the provider, an unverified one says why, and
   * neither ever serialises the token it resolved.
   */
  it('oauth + claude → reports a consistent verdict and never echoes the token', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'claude-opus-4-8',
        auth: { mode: 'oauth' },
      });
      const raw = await res.text();
      const body = JSON.parse(raw) as { verified: boolean; reason?: string; probe?: { reachable: boolean } };

      expect(typeof body.verified).toBe('boolean');
      if (body.verified) {
        // Verified means the probe ran and reached the provider — a verified tier with an
        // unreachable probe is the contradiction this pins.
        expect(body.probe, 'a verified oauth tier must carry its probe result').toBeDefined();
        expect(body.probe!.reachable).toBe(true);
      } else {
        // Unverified must say why; a bare `verified: false` is unactionable.
        expect(body.reason, 'an unverified oauth tier must explain itself').toMatch(/\S/);
      }
      // Whichever branch this machine takes: the resolved credential never reaches the wire.
      expect(raw).not.toMatch(/sk-ant-[A-Za-z0-9_-]{10,}/);
      expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/);
    } finally { await h.close(); }
  });
});
