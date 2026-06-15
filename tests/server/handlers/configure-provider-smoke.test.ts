import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { boot } from '../../contract/fixtures/harness.js';
import { mockProvider } from '../../contract/fixtures/mock-providers.js';

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
          { id: 'gpt-5' }, { id: 'deepseek-v4-pro' }, { id: 'MiniMax-M3' },
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

describe('configure-provider smoke', () => {
  it('validates and probes in one call', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'claude-opus-4-8',
        auth: { mode: 'api-key', apiKey: 'sk-ant-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        verified: true, applied: false,
        tier: 'standard', provider: 'claude',
        model: { id: 'claude-opus-4-8', family: 'claude', recognized: true },
      });
      expect(body.probe.reachable).toBe(true);
      expect(body.probe.modelListed).toBe(true);
    } finally { await h.close(); }
  });

  it('dryRun=false applies after probe passes', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'complex', provider: 'claude', model: 'claude-sonnet-4-6',
        auth: { mode: 'api-key', apiKey: 'sk-ant-applied', baseUrl: mockBaseUrl() },
        dryRun: false,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.applied).toBe(true);
      expect(body.reason).toMatch(/applied/i);
    } finally { await h.close(); }
  });

  it('incompatible provider-model fails before probe', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'standard', provider: 'claude', model: 'deepseek-v4-flash',
        auth: { mode: 'api-key', apiKey: 'sk-test' },
        dryRun: false,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(false);
      expect(body.applied).toBe(false);
      expect(body.probe).toBeUndefined();
    } finally { await h.close(); }
  });

  it('codex + deepseek probes correctly', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'complex', provider: 'codex', model: 'deepseek-v4-pro',
        auth: { mode: 'api-key', apiKey: 'sk-ds-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        verified: true, provider: 'codex',
        model: { id: 'deepseek-v4-pro', family: 'deepseek', tier: 'reasoning', recognized: true },
      });
      expect(body.probe.modelListed).toBe(true);
    } finally { await h.close(); }
  });

  it('codex + minimax probes correctly', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'standard', provider: 'codex', model: 'MiniMax-M3',
        auth: { mode: 'api-key', apiKey: 'mm-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        verified: true, provider: 'codex',
        model: { id: 'MiniMax-M3', family: 'minimax', recognized: true },
      });
    } finally { await h.close(); }
  });

  it('proxy baseUrl bypasses provider-family check', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, {
        tier: 'main', provider: 'codex', model: 'claude-opus-4-8',
        auth: { mode: 'api-key', apiKey: 'sk-test', baseUrl: mockBaseUrl() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.verified).toBe(true);
      expect(body.tier).toBe('main');
    } finally { await h.close(); }
  });

  it('rejects malformed input with 400', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await post(h.baseUrl, h.token, { provider: 'claude' });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_request');
    } finally { await h.close(); }
  });
});
