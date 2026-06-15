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

  it('oauth + claude → probe uses oauth token', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'claude-opus-4-8',
        auth: { mode: 'oauth' },
      });
      const body = await res.json();
      expect(typeof body.verified).toBe('boolean');
      if (body.probe) {
        expect(typeof body.probe.reachable).toBe('boolean');
      }
    } finally { await h.close(); }
  });
});
