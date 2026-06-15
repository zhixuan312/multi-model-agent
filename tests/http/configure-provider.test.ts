import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

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
          { id: 'claude-opus-4-8' }, { id: 'claude-sonnet-4-6' }, { id: 'claude-haiku-4-5' },
          { id: 'gpt-5' }, { id: 'gpt-5.5' },
          { id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' },
          { id: 'MiniMax-M3' }, { id: 'MiniMax-M2.7' },
          { id: 'my-custom-finetune-v3' },
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

async function authedFetch(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/configure-provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('POST /configure-provider', () => {
  // ── Schema validation ─────────────────────────────────────────────────────

  it('rejects empty body', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {});
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_request');
    } finally { await h.close(); }
  });

  it('rejects unknown provider type', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'gemini', model: 'gemini-3.5-flash',
        auth: { mode: 'api-key', apiKey: 'test-key' },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_request');
    } finally { await h.close(); }
  });

  it('rejects missing model', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude',
        auth: { mode: 'api-key', apiKey: 'test-key' },
      });
      expect(res.status).toBe(400);
    } finally { await h.close(); }
  });

  it('rejects api-key mode without apiKey', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'claude-opus-4-8',
        auth: { mode: 'api-key' },
      });
      expect(res.status).toBe(400);
    } finally { await h.close(); }
  });

  // ── dryRun behavior ───────────────────────────────────────────────────────

  it('defaults dryRun to true, applied is false', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'claude-opus-4-8',
        auth: { mode: 'api-key', apiKey: 'sk-ant-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.applied).toBe(false);
    } finally { await h.close(); }
  });

  it('dryRun false + verified → applied true', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'claude-opus-4-8',
        auth: { mode: 'api-key', apiKey: 'sk-ant-test', baseUrl: mockBaseUrl() },
        dryRun: false,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.applied).toBe(true);
      expect(body.reason).toMatch(/applied/i);
    } finally { await h.close(); }
  });

  it('dryRun false + not verified → applied false', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'gpt-5',
        auth: { mode: 'api-key', apiKey: 'sk-test' },
        dryRun: false,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.applied).toBe(false);
    } finally { await h.close(); }
  });

  // ── Claude provider ───────────────────────────────────────────────────────

  it('claude + claude model + api-key → verified', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'claude-opus-4-8',
        auth: { mode: 'api-key', apiKey: 'sk-ant-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.tier).toBe('standard');
      expect(body.provider).toBe('claude');
      expect(body.model.id).toBe('claude-opus-4-8');
      expect(body.model.family).toBe('claude');
      expect(body.model.recognized).toBe(true);
      expect(body.probe.reachable).toBe(true);
      expect(body.probe.modelListed).toBe(true);
    } finally { await h.close(); }
  });

  it('claude + claude-sonnet + api-key → verified, tier standard', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'complex', provider: 'claude', model: 'claude-sonnet-4-6',
        auth: { mode: 'api-key', apiKey: 'sk-ant-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.tier).toBe('complex');
      expect(body.model.family).toBe('claude');
      expect(body.model.tier).toBe('standard');
    } finally { await h.close(); }
  });

  it('claude + openai model (no baseUrl) → not verified (static fail, no probe)', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'gpt-5',
        auth: { mode: 'api-key', apiKey: 'sk-ant-test' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.reason).toMatch(/codex/i);
      expect(body.model.family).toBe('openai');
      expect(body.probe).toBeUndefined();
    } finally { await h.close(); }
  });

  it('claude + deepseek model (no baseUrl) → not verified', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'deepseek-v4-flash',
        auth: { mode: 'api-key', apiKey: 'sk-test' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.reason).toMatch(/codex/i);
      expect(body.model.family).toBe('deepseek');
    } finally { await h.close(); }
  });

  it('claude + minimax model (no baseUrl) → not verified', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'complex', provider: 'claude', model: 'MiniMax-M3',
        auth: { mode: 'api-key', apiKey: 'sk-test' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.reason).toMatch(/codex/i);
      expect(body.model.family).toBe('minimax');
    } finally { await h.close(); }
  });

  // ── Codex provider ────────────────────────────────────────────────────────

  it('codex + openai model + api-key → verified', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'gpt-5',
        auth: { mode: 'api-key', apiKey: 'sk-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.model.family).toBe('openai');
      expect(body.model.tier).toBe('reasoning');
    } finally { await h.close(); }
  });

  it('codex + deepseek + baseUrl → verified', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'deepseek-v4-flash',
        auth: { mode: 'api-key', apiKey: 'sk-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.model.family).toBe('deepseek');
      expect(body.model.recognized).toBe(true);
    } finally { await h.close(); }
  });

  it('codex + deepseek-v4-pro → verified, reasoning tier', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'complex', provider: 'codex', model: 'deepseek-v4-pro',
        auth: { mode: 'api-key', apiKey: 'sk-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.model.family).toBe('deepseek');
      expect(body.model.tier).toBe('reasoning');
    } finally { await h.close(); }
  });

  it('codex + MiniMax-M3 + baseUrl → verified', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'MiniMax-M3',
        auth: { mode: 'api-key', apiKey: 'sk-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.model.family).toBe('minimax');
      expect(body.model.recognized).toBe(true);
    } finally { await h.close(); }
  });

  it('codex + MiniMax-M2.7 → recognized as reasoning', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'complex', provider: 'codex', model: 'MiniMax-M2.7',
        auth: { mode: 'api-key', apiKey: 'sk-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.model.family).toBe('minimax');
      expect(body.model.tier).toBe('reasoning');
    } finally { await h.close(); }
  });

  it('codex + claude model (no baseUrl) → not verified', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'claude-opus-4-8',
        auth: { mode: 'api-key', apiKey: 'sk-test' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.reason).toMatch(/claude/i);
    } finally { await h.close(); }
  });

  // ── Custom baseUrl bypasses family check ──────────────────────────────────

  it('claude + non-claude model + baseUrl → verified (proxy)', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'deepseek-v4-flash',
        auth: { mode: 'api-key', apiKey: 'sk-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.model.family).toBe('deepseek');
    } finally { await h.close(); }
  });

  it('codex + claude model + baseUrl → verified (proxy)', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'claude-opus-4-8',
        auth: { mode: 'api-key', apiKey: 'sk-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.model.family).toBe('claude');
    } finally { await h.close(); }
  });

  // ── Unrecognized model ────────────────────────────────────────────────────

  it('unrecognized model + baseUrl → verified, recognized false', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'my-custom-finetune-v3',
        auth: { mode: 'api-key', apiKey: 'sk-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.model.family).toBe('other');
      expect(body.model.recognized).toBe(false);
    } finally { await h.close(); }
  });

  it('unrecognized model + no baseUrl → not verified', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'my-custom-finetune-v3',
        auth: { mode: 'api-key', apiKey: 'sk-test' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.reason).toMatch(/unrecognized|unknown/i);
    } finally { await h.close(); }
  });

  // ── Main tier ─────────────────────────────────────────────────────────────

  it('main tier is accepted', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'main', provider: 'claude', model: 'claude-opus-4-8',
        auth: { mode: 'api-key', apiKey: 'sk-ant-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.tier).toBe('main');
    } finally { await h.close(); }
  });

  // ── OAuth mode ────────────────────────────────────────────────────────────

  it('claude + oauth → checks oauth availability', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'claude-opus-4-8',
        auth: { mode: 'oauth' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.verified).toBe('boolean');
      expect(body.provider).toBe('claude');
      expect(body.model.id).toBe('claude-opus-4-8');
      expect(typeof body.reason).toBe('string');
      expect(typeof body.applied).toBe('boolean');
    } finally { await h.close(); }
  });

  it('codex + oauth → checks codex auth availability', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'gpt-5',
        auth: { mode: 'oauth' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.verified).toBe('boolean');
      expect(body.provider).toBe('codex');
    } finally { await h.close(); }
  });

  // ── Response shape ────────────────────────────────────────────────────────

  it('response always has verified, reason, applied, tier, provider, model, probe fields', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'claude-haiku-4-5',
        auth: { mode: 'api-key', apiKey: 'sk-ant-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('verified');
      expect(body).toHaveProperty('reason');
      expect(body).toHaveProperty('applied');
      expect(body).toHaveProperty('tier');
      expect(body).toHaveProperty('provider');
      expect(body).toHaveProperty('model');
      expect(body).toHaveProperty('probe');
      expect(body.model).toHaveProperty('id');
      expect(body.model).toHaveProperty('family');
      expect(body.model).toHaveProperty('tier');
      expect(body.model).toHaveProperty('recognized');
      expect(body.probe).toHaveProperty('reachable');
      expect(body.probe).toHaveProperty('modelListed');
      expect(body.probe).toHaveProperty('detail');
    } finally { await h.close(); }
  });

  // ── Probe: bad key detected ───────────────────────────────────────────────

  it('bad api key → probe catches 401, verified false', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await authedFetch(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'gpt-5',
        auth: { mode: 'api-key', apiKey: 'bad-key', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.probe.reachable).toBe(false);
      expect(body.probe.detail).toMatch(/401/);
    } finally { await h.close(); }
  });

  // ── Auth required ─────────────────────────────────────────────────────────

  it('requires bearer auth', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/configure-provider`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: 'standard', provider: 'claude', model: 'claude-opus-4-8',
          auth: { mode: 'api-key', apiKey: 'sk-test' },
        }),
      });
      expect(res.status).toBe(401);
    } finally { await h.close(); }
  });
});
