// tests/server/handlers/tools/execute-plan.test.ts
import { describe, it, expect } from 'vitest';
import { startTestServerWithAgents } from '../../../helpers/test-server-with-agents.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeTmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'mmagent-execute-plan-test-'));
}

describe('POST /execute-plan handler', () => {
  it('returns 202 with batchId and statusUrl on valid request', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    // Create a fake plan file so executeExecutePlan can read it
    const planFile = join(cwd, 'plan.md');
    writeFileSync(planFile, '## Task 1: Setup\nDo the setup.');
    try {
      const body = {
        tasks: ['Task 1: Setup'],
        filePaths: [planFile],
      };
      const res = await fetch(`${s.url}/execute-plan?cwd=${encodeURIComponent(cwd)}`, {
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

  it('returns 400 invalid_request when tasks array is missing', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const res = await fetch(`${s.url}/execute-plan?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ filePaths: ['/some/plan.md'] }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_request');
    } finally {
      await s.stop();
    }
  });

  it('returns 400 invalid_request when tasks is empty', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const res = await fetch(`${s.url}/execute-plan?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tasks: [], filePaths: ['/some/plan.md'] }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_request');
    } finally {
      await s.stop();
    }
  });
});
