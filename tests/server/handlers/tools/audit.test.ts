// tests/server/handlers/tools/audit.test.ts
import { describe, it, expect } from 'bun:test';
import { startTestServerWithAgents } from '../../../helpers/test-server-with-agents.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeTmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'mmagent-audit-test-'));
}

describe('POST /audit handler', () => {
  it('returns 202 with batchId and statusUrl on valid request', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const body = {
        document: 'function foo() { return 1; }',
        subtype: 'default',
      };
      const res = await fetch(`${s.url}/audit?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(202);
      const json = await res.json() as { batchId: string; statusUrl: string };
      expect(json.batchId).toBeTypeOf('string');
      expect(json.statusUrl).toBe(`/batch/${json.batchId}`);
    } finally {
      await s.stop();
    }
  });

  it('accepts request with subtype omitted (Zod default fires to `default`)', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const res = await fetch(`${s.url}/audit?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ document: 'some prose to audit, more than a few words so the spec compiler does not balk.' }),
      });

      expect(res.status).toBe(202);
      const json = await res.json() as { batchId: string };
      expect(json.batchId).toBeTypeOf('string');
    } finally {
      await s.stop();
    }
  });

  it('returns 400 invalid_request when the legacy auditType field is sent', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      for (const legacy of ['default', 'plan', 'security', 'performance', 'correctness', 'style', 'general']) {
        const res = await fetch(`${s.url}/audit?cwd=${encodeURIComponent(cwd)}`, {
          method: 'POST',
          headers: {
            "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
            Authorization: `Bearer ${s.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ document: 'code', auditType: legacy }),
        });
        expect(res.status, `legacy auditType='${legacy}' should be rejected (renamed to subtype)`).toBe(400);
        const json = await res.json() as { error: { code: string } };
        expect(json.error.code).toBe('invalid_request');
      }
    } finally {
      await s.stop();
    }
  });

  it('returns 400 invalid_request when subtype is an invalid value', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const res = await fetch(`${s.url}/audit?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ document: 'code', subtype: 'unknown-type' }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_request');
    } finally {
      await s.stop();
    }
  });
});
