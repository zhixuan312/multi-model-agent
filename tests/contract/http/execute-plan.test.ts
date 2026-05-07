import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider, type Stage } from '../fixtures/mock-providers.js';
import { normalize } from '../serializer/index.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STAGES: Stage[] = ['ok', 'incomplete', 'max-turns', 'review-rework'];

async function pollToTerminal(baseUrl: string, token: string, batchId: string): Promise<ReturnType<typeof normalize>> {
  for (let i = 0; i < 180; i++) {
    const poll = await fetch(`${baseUrl}/batch/${batchId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (poll.status === 200) return normalize((await poll.json()) as any);
    if (poll.status !== 202) throw new Error(`Unexpected status ${poll.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout ${batchId}`);
}

function makeTmpPlan(heading: string): { dir: string; planPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mma-contract-execute-plan-'));
  const planPath = join(dir, 'plan.md');
  writeFileSync(planPath, `# Test Plan\n\n## ${heading}\n\nDo the thing.\n`, 'utf8');
  return { dir, planPath };
}

describe('contract: POST /execute-plan', () => {
  for (const stage of STAGES) {
    it(`produces the ${stage} envelope`, async () => {
      const heading = `1. golden execute-plan test task ${stage}`;
      const { dir, planPath } = makeTmpPlan(heading);
      const h = await boot({ provider: mockProvider({ stage }), cwd: dir });
      try {
        const dispatch = await fetch(`${h.baseUrl}/execute-plan?cwd=${encodeURIComponent(dir)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
          body: JSON.stringify({ filePaths: [planPath], taskDescriptors: [heading] }),
        });
        expect(dispatch.status).toBe(202);
        const { batchId } = (await dispatch.json()) as { batchId: string };
        const terminal = await pollToTerminal(h.baseUrl, h.token, batchId);
        const goldenRel = `../goldens/endpoints/execute-plan-${stage}.json`;
        if (process.env.CAPTURE_GOLDEN === '1') {
          const { writeFileSync } = await import('node:fs');
          const { resolve, dirname } = await import('node:path');
          const { fileURLToPath } = await import('node:url');
          const here = dirname(fileURLToPath(import.meta.url));
          writeFileSync(resolve(here, goldenRel), JSON.stringify(terminal, null, 2) + '\n', 'utf8');
        } else {
          const expected = (await import(goldenRel, { with: { type: 'json' } })).default;
          expect(terminal).toEqual(expected);
        }
      } finally {
        await h.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  }
});

describe('POST /execute-plan rejects agentType', () => {
  it('top-level agentType → 400 with unrecognized key in formErrors', async () => {
    const { dir, planPath } = makeTmpPlan('test task');
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: dir });
    try {
      const res = await fetch(`${h.baseUrl}/execute-plan?cwd=${encodeURIComponent(dir)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
        body: JSON.stringify({ agentType: 'complex', filePaths: [planPath], taskDescriptors: ['test task'] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_request');
      // Zod .strict() puts unrecognized keys in formErrors
      expect(body.error.details.fieldErrors.formErrors).toEqual(
        expect.arrayContaining([expect.stringContaining('agentType')]),
      );
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('per-task agentType → 400 with unrecognized key in formErrors', async () => {
    const { dir, planPath } = makeTmpPlan('test task');
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: dir });
    try {
      const res = await fetch(`${h.baseUrl}/execute-plan?cwd=${encodeURIComponent(dir)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
        body: JSON.stringify({ filePaths: [planPath], taskDescriptors: [], agentType: 'complex' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_request');
      expect(body.error.details.fieldErrors.formErrors).toEqual(
        expect.arrayContaining([expect.stringContaining('agentType')]),
      );
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('both top-level and per-task agentType → both keys in formErrors', async () => {
    const { dir, planPath } = makeTmpPlan('test task');
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: dir });
    try {
      const res = await fetch(`${h.baseUrl}/execute-plan?cwd=${encodeURIComponent(dir)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
        body: JSON.stringify({ agentType: 'complex', filePaths: [planPath], taskDescriptors: ['test task'] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_request');
      expect(body.error.details.fieldErrors.formErrors).toEqual(
        expect.arrayContaining([expect.stringContaining('agentType')]),
      );
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
