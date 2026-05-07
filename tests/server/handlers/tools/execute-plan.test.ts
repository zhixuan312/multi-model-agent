// tests/server/handlers/tools/execute-plan.test.ts
import { describe, it, expect } from 'vitest';
import { startTestServerWithAgents } from '../../../helpers/test-server-with-agents.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeTmpCwdWithPlan(): { cwd: string; planPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'mmagent-execute-plan-test-'));
  const planPath = join(cwd, 'plan.md');
  writeFileSync(planPath, '## Task 1: Setup\nDo the setup.\n', 'utf8');
  return { cwd, planPath };
}

describe('POST /execute-plan handler', () => {
  it('returns 202 with batchId and statusUrl on valid request', async () => {
    const s = await startTestServerWithAgents();
    const { cwd, planPath } = makeTmpCwdWithPlan();
    try {
      const body = {
        taskDescriptors: ['Task 1: Setup'],
        filePaths: [planPath],
      };
      const res = await fetch(`${s.url}/execute-plan?cwd=${encodeURIComponent(cwd)}`, {
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
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns 400 invalid_request when taskDescriptors array is missing', async () => {
    const s = await startTestServerWithAgents();
    const { cwd, planPath } = makeTmpCwdWithPlan();
    try {
      const res = await fetch(`${s.url}/execute-plan?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ filePaths: [planPath] }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_request');
    } finally {
      await s.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns 400 invalid_request when taskDescriptors is empty', async () => {
    const s = await startTestServerWithAgents();
    const { cwd, planPath } = makeTmpCwdWithPlan();
    try {
      const res = await fetch(`${s.url}/execute-plan?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ taskDescriptors: [], filePaths: [planPath] }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_request');
    } finally {
      await s.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns 400 invalid_request when agentType is present', async () => {
    const s = await startTestServerWithAgents();
    const { cwd, planPath } = makeTmpCwdWithPlan();
    try {
      const res = await fetch(`${s.url}/execute-plan?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ agentType: 'complex', taskDescriptors: ['Task 1: Setup'], filePaths: [planPath] }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_request');
    } finally {
      await s.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
