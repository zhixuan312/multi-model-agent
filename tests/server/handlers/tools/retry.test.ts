// tests/server/handlers/tools/retry.test.ts
import { describe, it, expect } from 'vitest';
import { startTestServerWithAgents } from '../../../helpers/test-server-with-agents.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeTmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'mmagent-retry-test-'));
}

describe('POST /retry handler', () => {
  it('returns 202 with batchId and statusUrl on valid request', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      // Any batchId is valid syntactically; the executor will fail async (after 202 is returned)
      const body = {
        batchId: 'some-prior-batch-id',
        taskIndices: [0, 1],
      };
      const res = await fetch(`${s.url}/retry?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
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

  it('returns 400 invalid_request when batchId is missing', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const res = await fetch(`${s.url}/retry?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ taskIndices: [0] }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_request');
    } finally {
      await s.stop();
    }
  });

  it('returns 400 invalid_request when taskIndices is missing', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const res = await fetch(`${s.url}/retry?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ batchId: 'some-batch' }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_request');
    } finally {
      await s.stop();
    }
  });
});
