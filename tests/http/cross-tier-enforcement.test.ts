import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { assertCrossTierConfigured } from '../../packages/server/src/http/cross-tier-guard.js';
import { startServer } from '../../packages/server/src/http/server.js';
import { __setTestProviderOverride } from '../../packages/server/src/http/test-provider-override.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

// ── Lightweight mock ServerResponse for unit tests ───────────────────────

function makeRes(): { statusCode: number; headers: Record<string, string>; body: string } {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      if (headers) Object.assign(res.headers, headers);
      return { end: (data?: string) => { res.body = data ?? ''; } } as any;
    },
    end(data?: string) {
      res.body = data ?? '';
      return {} as any;
    },
  };
  return res;
}

function makeConfig(agents?: { standard?: unknown; complex?: unknown }) {
  return {
    agents,
    defaults: {
      timeoutMs: 1_800_000,
      maxCostUSD: 10,
      tools: 'full' as const,
      sandboxPolicy: 'cwd-only' as const,
    },
    server: {
      bind: '127.0.0.1',
      port: 0,
      auth: { tokenFile: '/tmp/not-used' },
      limits: {},
    },
  } as unknown as Parameters<typeof assertCrossTierConfigured>[0];
}

const stubAgent = {
  type: 'openai-compatible' as const,
  baseUrl: 'http://mock.local',
  apiKey: 'stub',
  model: 'mock',
};

describe('assertCrossTierConfigured (unit)', () => {
  it('returns true when both slots are configured', () => {
    const config = makeConfig({ standard: stubAgent, complex: stubAgent });
    expect(assertCrossTierConfigured(config, makeRes() as any)).toBe(true);
  });

  it('returns false and sends 400 when complex slot is missing', () => {
    const config = makeConfig({ standard: stubAgent });
    const res = makeRes();
    expect(assertCrossTierConfigured(config, res as any)).toBe(false);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('invalid_configuration');
    expect(body.error.message).toMatch(/complex/);
  });

  it('returns false and sends 400 when standard slot is missing', () => {
    const config = makeConfig({ complex: stubAgent });
    const res = makeRes();
    expect(assertCrossTierConfigured(config, res as any)).toBe(false);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('invalid_configuration');
    expect(body.error.message).toMatch(/standard/);
  });

  it('does NOT skip check when MMAGENT_READ_ONLY_REVIEW=disabled (handlers guard the call)', () => {
    // The kill switch is now checked in the handlers BEFORE calling
    // assertCrossTierConfigured. The guard itself always validates
    // cross-tier configuration, regardless of the env var.
    const config = makeConfig({ standard: stubAgent }); // missing complex
    process.env.MMAGENT_READ_ONLY_REVIEW = 'disabled';
    try {
      const res = makeRes();
      expect(assertCrossTierConfigured(config, res as any)).toBe(false);
      expect(res.statusCode).toBe(400);
    } finally {
      delete process.env.MMAGENT_READ_ONLY_REVIEW;
    }
  });

  it('sends 400 with message mentioning read-only routes when standard is missing', () => {
    const config = makeConfig({ complex: stubAgent });
    const res = makeRes();
    assertCrossTierConfigured(config, res as any);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/read-only/i);
    expect(body.error.message).toMatch(/standard/);
  });

  it('sends 400 with message mentioning read-only routes when complex is missing', () => {
    const config = makeConfig({ standard: stubAgent });
    const res = makeRes();
    assertCrossTierConfigured(config, res as any);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/read-only/i);
    expect(body.error.message).toMatch(/complex/);
  });
});

// ── Integration: boot a real server with partial agent config ─────────────

async function bootWithAgents(agents: { standard?: unknown; complex?: unknown }): Promise<{
  baseUrl: string; token: string; close(): Promise<void>;
}> {
  const token = randomUUID();
  const tokenPath = join(tmpdir(), `mmagent-xtier-${randomUUID()}`);
  writeFileSync(tokenPath, `${token}\n`, 'utf8');

  process.env.MMAGENT_TEST_PROVIDER_OVERRIDE = '1';
  __setTestProviderOverride(mockProvider({ stage: 'ok' }));

  const config = {
    agents,
    defaults: {
      timeoutMs: 1_800_000,
      maxCostUSD: 10,
      tools: 'full' as const,
      sandboxPolicy: 'cwd-only' as const,
    },
    server: {
      bind: '127.0.0.1',
      port: 0,
      auth: { tokenFile: tokenPath },
      limits: {
        maxBodyBytes: 10_485_760,
        batchTtlMs: 3_600_000,
        idleProjectTimeoutMs: 1_800_000,
        clarificationTimeoutMs: 86_400_000,
        projectCap: 200,
        maxBatchCacheSize: 500,
        maxContextBlockBytes: 524_288,
        maxContextBlocksPerProject: 32,
        shutdownDrainMs: 30_000,
      },
      autoUpdateSkills: false,
    },
  };

  const server = await startServer(config as any);
  const baseUrl = `http://127.0.0.1:${server.port}`;

  return {
    baseUrl,
    token,
    async close() {
      await server.stop();
      __setTestProviderOverride(null);
      await unlink(tokenPath).catch(() => undefined);
    },
  };
}

describe('cross-tier enforcement at HTTP dispatch', () => {
  it('returns 400 invalid_configuration when only complex slot is configured', async () => {
    const h = await bootWithAgents({ complex: stubAgent });
    try {
      const res = await fetch(`${h.baseUrl}/audit?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
        body: JSON.stringify({ auditType: 'correctness', filePaths: ['/nonexistent'] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error.code).toBe('invalid_configuration');
      expect(body.error.message).toMatch(/read-only/i);
      expect(body.error.message).toMatch(/standard/);
    } finally {
      await h.close();
    }
  });

  it('returns 400 when only standard slot is configured', async () => {
    const h = await bootWithAgents({ standard: stubAgent });
    try {
      const res = await fetch(`${h.baseUrl}/review?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
        body: JSON.stringify({ code: 'function add(a,b){return a+b;}' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error.code).toBe('invalid_configuration');
    } finally {
      await h.close();
    }
  });

  it('proceeds when both slots configured (returns 202 with batchId)', async () => {
    const h = await bootWithAgents({ standard: stubAgent, complex: stubAgent });
    try {
      const res = await fetch(`${h.baseUrl}/audit?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
        body: JSON.stringify({ auditType: 'correctness', filePaths: ['/nonexistent'] }),
      });
      expect(res.status).toBe(202);
      const body = await res.json() as any;
      expect(body.batchId).toBeTruthy();
    } finally {
      await h.close();
    }
  });

  it('skips the cross-tier check when MMAGENT_READ_ONLY_REVIEW=disabled (even with missing slot)', async () => {
    process.env.MMAGENT_READ_ONLY_REVIEW = 'disabled';
    const h = await bootWithAgents({ complex: stubAgent }); // only complex, no standard
    try {
      const res = await fetch(`${h.baseUrl}/verify?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
        body: JSON.stringify({ work: 'function add(a,b){return a+b;}', checklist: ['Does it compile?'] }),
      });
      expect(res.status).not.toBe(400);
    } finally {
      delete process.env.MMAGENT_READ_ONLY_REVIEW;
      await h.close();
    }
  });

  it('returns 400 for all 5 read-only routes when a slot is missing', async () => {
    const h = await bootWithAgents({ complex: stubAgent }); // only complex, no standard
    try {
      const routes: Array<{ route: string; body: unknown }> = [
        { route: 'audit', body: { auditType: 'correctness', filePaths: ['/nonexistent'] } },
        { route: 'review', body: { code: 'function add(a,b){return a+b;}' } },
        { route: 'verify', body: { checklist: ['Does it work?'], filePaths: ['/nonexistent'] } },
        { route: 'debug', body: { problem: 'something is broken', filePaths: ['/nonexistent'] } },
        { route: 'investigate', body: { question: 'what is this?', filePaths: ['/nonexistent'] } },
      ];

      for (const { route, body } of routes) {
        const res = await fetch(`${h.baseUrl}/${route}?cwd=${encodeURIComponent(process.cwd())}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
          body: JSON.stringify(body),
        });
        expect(res.status, `${route} should return 400`).toBe(400);
        const json = await res.json() as any;
        expect(json.error.code, `${route} error code`).toBe('invalid_configuration');
      }
    } finally {
      await h.close();
    }
  });

  it('write routes (delegate, execute-plan) are not affected by the guard', async () => {
    const h = await bootWithAgents({ complex: stubAgent }); // only complex, no standard
    try {
      // /delegate should not be blocked (it's a write route, not read-only)
      const res = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
        body: JSON.stringify({ tasks: [{ prompt: 'say hello' }] }),
      });
      // delegate should proceed (202) — not 400 from cross-tier guard
      expect(res.status).toBe(202);
    } finally {
      await h.close();
    }
  });
});
