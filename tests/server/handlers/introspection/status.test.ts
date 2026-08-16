// tests/server/handlers/introspection/status.test.ts
import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import { startTestServer } from '../../../helpers/test-server.js';
import { startTestServerWithAgents } from '../../../helpers/test-server-with-agents.js';
import { shouldRejectNonLoopback } from '../../../../packages/core/src/transport/loopback-enforcer.js';
import { realpathSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildStatusHandler } from '../../../../packages/server/src/http/handlers/introspection/status.js';
import { ExecutionRegistry } from '@zhixuan92/multi-model-agent-core';
import { ProjectRegistry } from '../../../../packages/server/src/application/project-registry.js';

/** Minimal ServerResponse capture — the handler only writes a status and a JSON body. */
function fakeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let statusCode = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { statusCode = code; return res; },
    end(chunk?: string) { if (chunk) payload = chunk; },
    setHeader() { /* no-op */ },
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => JSON.parse(payload) as Record<string, unknown> };
}

/** The handler ignores both, but `RawHandler` requires them. */
const CTX = { url: new URL('http://127.0.0.1/status'), callerClient: 'claude-code' as const } as never;

function statusHandlerOver(homeDir: string) {
  return buildStatusHandler({
    executionRegistry: new ExecutionRegistry(),
    projectRegistry: new ProjectRegistry({ cap: 10 }),
    serverStartedAt: Date.now(),
    bind: '127.0.0.1',
    version: '0.0.0-test',
    homeDir,
  });
}

describe('GET /status', () => {
  it('returns 401 without bearer token', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/status`);
      expect(res.status).toBe(401);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
    } finally {
      await s.stop();
    }
  });

  it('returns 401 with wrong bearer token', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/status`, {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
    } finally {
      await s.stop();
    }
  });

  // Loopback guard: fetch() from localhost is always loopback so we can't
  // trigger 403 via the network — test shouldRejectNonLoopback directly.
  describe('loopback guard (unit)', () => {
    it('should reject non-loopback addresses', () => {
      expect(shouldRejectNonLoopback('10.0.0.1')).toBe(true);
      expect(shouldRejectNonLoopback('192.168.0.1')).toBe(true);
      expect(shouldRejectNonLoopback('203.0.113.5')).toBe(true);
    });

    it('should allow loopback addresses', () => {
      expect(shouldRejectNonLoopback('127.0.0.1')).toBe(false);
      expect(shouldRejectNonLoopback('::1')).toBe(false);
      expect(shouldRejectNonLoopback('::ffff:127.0.0.1')).toBe(false);
    });
  });

  it('returns 200 with §5.10 shape for valid auth from loopback', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/status`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const body = await res.json() as Record<string, unknown>;

      // Top-level shape check (toMatchObject for stability against version bumps)
      expect(body).toMatchObject({
        pid: expect.any(Number),
        bind: expect.any(String),
        uptimeMs: expect.any(Number),
        auth: { enabled: true },
        counters: {
          projectCount: expect.any(Number),
          activeTasks: expect.any(Number),
        },
        projects: expect.any(Array),
        inflight: expect.any(Array),
      });

      // version must be a semver string
      expect(typeof body['version']).toBe('string');
      expect((body['version'] as string).length).toBeGreaterThan(0);

      // uptimeMs must be non-negative
      expect(body['uptimeMs'] as number).toBeGreaterThanOrEqual(0);

      // pid must match the current process
      expect(body['pid']).toBe(process.pid);

      // auth is always enabled in 3.0.0
      expect((body['auth'] as { enabled: boolean }).enabled).toBe(true);
    } finally {
      await s.stop();
    }
  });

  /**
   * Driven at the handler, over a temp home, so the manifest state is the test's to decide.
   *
   * This used to boot a server and assert `sv === null || typeof sv === 'string'` — true for
   * almost any value — with a comment conceding "we can't assert null with certainty if the
   * developer has the skill installed". It could not: `buildStatusHandler` called
   * `deriveSkillManifestInfo()` with no argument, so the response reported whatever was installed
   * for whoever ran the suite. The function has always taken a `homeDir`; the handler now threads
   * one, which makes both documented outcomes reachable.
   */
  describe('skill manifest reporting', () => {
    it('reports null/null when no install manifest exists', async () => {
      const home = mkdtempSync(join(tmpdir(), 'mma-status-empty-'));
      try {
        const { res, status, body } = fakeRes();
        await statusHandlerOver(home)({} as IncomingMessage, res, {}, CTX);
        expect(status()).toBe(200);
        expect(body()['skillVersion']).toBeNull();
        expect(body()['skillCompatible']).toBeNull();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('reports skillCompatible false when the manifest version differs from the bundle', async () => {
      const home = mkdtempSync(join(tmpdir(), 'mma-status-installed-'));
      try {
        // The version recorded here is deliberately NOT the bundled one, so `isSkillBehind`
        // sees a difference and reports incompatible — the drift signal an operator acts on.
        mkdirSync(join(home, '.mma'), { recursive: true });
        writeFileSync(join(home, '.mma', 'install-manifest.json'), JSON.stringify({
          version: 2,
          entries: [{ name: 'mma-audit', skillVersion: '0.0.0-not-the-bundled-one', installedAt: 1_700_000_000_000, targets: ['claude-code'] }],
        }), 'utf8');

        const { res, status, body } = fakeRes();
        await statusHandlerOver(home)({} as IncomingMessage, res, {}, CTX);
        expect(status()).toBe(200);
        expect(body()['skillVersion']).toBe('0.0.0-not-the-bundled-one');
        expect(body()['skillCompatible']).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    /**
     * The COMPATIBLE path, which nothing covered.
     *
     * The case above is named "…and compatible, when the manifest matches the bundle" and then
     * deliberately writes a version that does NOT match, asserting `false`. So the name stated the
     * opposite of the assertions, and a reader scanning names believed the compatible path was
     * covered when no test reached it — `skillCompatible` could have been hardcoded `false` and
     * this file would have stayed green.
     */
    it('reports skillCompatible true when the manifest matches the bundled version', async () => {
      const home = mkdtempSync(join(tmpdir(), 'mma-status-match-'));
      try {
        // Read the bundled version from the packaged skill itself, so this tracks a version bump
        // instead of pinning a literal that would have to be edited on every release.
        const bundled = matter(
          readFileSync('packages/server/src/skills/mma-audit/SKILL.md', 'utf8'),
        ).data['version'] as string;
        expect(bundled, 'the packaged skill carries no version — this test cannot mean anything')
          .toBeTruthy();

        mkdirSync(join(home, '.mma'), { recursive: true });
        writeFileSync(join(home, '.mma', 'install-manifest.json'), JSON.stringify({
          version: 2,
          entries: [{ name: 'mma-audit', skillVersion: bundled, installedAt: 1_700_000_000_000, targets: ['claude-code'] }],
        }), 'utf8');

        const { res, status, body } = fakeRes();
        await statusHandlerOver(home)({} as IncomingMessage, res, {}, CTX);
        expect(status()).toBe(200);
        expect(body()['skillVersion']).toBe(bundled);
        expect(body()['skillCompatible']).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  /**
   * This asserted `projectCount === projects.length` against a server on which nothing had been
   * registered, so it compared 0 to 0 — and the comparison is a tautology besides: `projectCount`
   * is `projectRegistry.size` and `projects` is built by iterating `projectRegistry.entries()`,
   * both views of the same Map, so no handler change could make them disagree.
   *
   * The relation worth pinning is the OTHER counter, which really does come from two code paths:
   * `counters.activeTasks` is `allInFlight().length` (registry-wide) while each `projects[i]
   * .activeTasks` is `countActive(cwd)` (per-project). Those can diverge — an in-flight execution
   * whose cwd never made it into the project registry would be counted once and not the other.
   */
  it('reports a registered project, and reconciles its two independent activeTasks counts', async () => {
    const s = await startTestServerWithAgents();
    const cwd = mkdtempSync(join(tmpdir(), 'mma-status-project-'));
    try {
      // Registering a context block reserves the project — the same `reserveProject` path a
      // dispatch takes, without needing a live agent.
      const reg = await fetch(`${s.url}/context-blocks?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          'X-MMA-Main-Model': 'claude-opus-4-7', 'X-MMA-Client': 'claude-code',
          Authorization: `Bearer ${s.token}`, 'content-type': 'application/json',
        },
        body: JSON.stringify({ content: 'status counter fixture' }),
      });
      expect(reg.status, 'could not reserve a project — the assertions below would be vacuous')
        .toBe(201);

      const res = await fetch(`${s.url}/status`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        counters: { projectCount: number; activeTasks: number };
        projects: { cwd: string; activeTasks: number; contextBlockCount: number }[];
        inflight: unknown[];
      };

      // FLOOR: there is a project to report on.
      expect(body.counters.projectCount).toBeGreaterThan(0);
      expect(body.counters.projectCount).toBe(body.projects.length);

      // The registered project is the one reported, with the block counted against it.
      const mine = body.projects.find((p) => p.cwd === realpathSync(cwd));
      expect(mine, `status listed ${JSON.stringify(body.projects.map((p) => p.cwd))}, not ${cwd}`)
        .toBeDefined();
      expect(mine!.contextBlockCount).toBe(1);

      // The two independently-derived active counts agree.
      const perProject = body.projects.reduce((n, p) => n + p.activeTasks, 0);
      expect(body.counters.activeTasks, 'registry-wide and per-project active counts disagree')
        .toBe(perProject);
      expect(body.counters.activeTasks).toBe(body.inflight.length);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await s.stop();
    }
  });
});
