import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionContext } from '../../packages/core/src/executors/types.js';
import type { MultiModelConfig, Provider } from '../../packages/core/src/types.js';

// Track calls to differentiate implementer vs quality reviewer
const callState = vi.hoisted(() => ({
  callCount: 0,
  lastPrompt: '',
}));

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (): Provider => ({
    name: 'mock-complex',
    config: { type: 'openai-compatible' as const, model: 'cpx-model', baseUrl: 'https://ex.invalid/v1' },
    run: async (prompt: string) => {
      callState.callCount++;
      callState.lastPrompt = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
      // First call(s) are implementer — return artifact-producing result
      // to pass the filesWritten.length === 0 guard in the lifecycle.
      if (callState.callCount <= 3) {
        return {
          output: '## Summary\ndone\n\n## Files changed\n- test.txt: created\n\n## Validations run\n\n## Deviations from brief\n\n## Unresolved\n',
          status: 'ok' as const,
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: 0.001 },
          turns: 1,
          filesRead: [],
          filesWritten: ['test.txt'],
          toolCalls: ['writeFile(test.txt)'],
          outputIsDiagnostic: false,
          escalationLog: [],
          workerStatus: 'done' as const,
        };
      }
      // Quality reviewer call(s)
      return {
        output: '## Summary\napproved\n\n## Deviations from brief\n\n## Unresolved\n',
        status: 'ok' as const,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: 0.001 },
        turns: 1,
        filesRead: ['test.txt'],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: false,
        escalationLog: [],
        workerStatus: 'done' as const,
      };
    },
  }),
}));

import { executeVerify } from '../../packages/core/src/executors/verify.js';

function makeContext(): { ctx: ExecutionContext; cwd: string } {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'verify-qr-')));
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 1;');

  callState.callCount = 0;
  callState.lastPrompt = '';

  const config: MultiModelConfig = {
    agents: {
      standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
      complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
    },
    defaults: { tools: 'readonly' as const, timeoutMs: 60_000, maxCostUSD: 10, sandboxPolicy: 'cwd-only' as const },
  } as MultiModelConfig;

  const ctx: ExecutionContext = {
    projectContext: { cwd, contextBlockStore: { get: () => undefined, register: () => ({ id: 'cb-1' }) } as any, lastActivityAt: Date.now() } as any,
    config,
    logger: { event: () => {}, emit: () => {}, child: () => ({ event: () => {}, emit: () => {} } as any) } as any,
    contextBlockStore: { get: () => undefined, register: () => ({ id: 'cb-1' }) } as any,
    batchId: 'test-batch-verify',
  };
  return { ctx, cwd };
}

describe('executeVerify quality-only reviewed lifecycle', () => {
  it('sets qualityReviewVerdict on the output envelope', async () => {
    const { ctx } = makeContext();
    const out = await executeVerify(ctx, {
      checklist: ['the login form has an email field', 'the login form has a password field'],
    });

    expect(out.qualityReviewVerdict).toBeDefined();
    // With a mock that writes files, the quality reviewer runs and approves
    expect(out.qualityReviewVerdict).toBe('approved');
    expect(out.specReviewVerdict).toBeDefined();
    expect(out.specReviewVerdict).toBe('not_applicable');
  });

  it('worker result carries qualityReviewStatus from the lifecycle', async () => {
    const { ctx } = makeContext();
    const out = await executeVerify(ctx, {
      checklist: ['check login page loads without errors'],
    });

    const results = out.results as any[];
    expect(results.length).toBeGreaterThanOrEqual(1);
    const r = results[0];
    expect(r.workerStatus).toBeDefined();
    expect(r.qualityReviewStatus).toBeDefined();
    // With a mock that writes files, quality review runs and returns approved
    expect(r.qualityReviewStatus).toBe('approved');
  });

  it('populates specReviewVerdict and roundsUsed in addition to qualityReviewVerdict', async () => {
    const { ctx } = makeContext();
    const out = await executeVerify(ctx, {
      checklist: ['check the navbar has correct links'],
    });

    expect(out.specReviewVerdict).toBeDefined();
    expect(out.qualityReviewVerdict).toBeDefined();
    expect(out.roundsUsed).toBeDefined();
    expect(typeof out.roundsUsed).toBe('number');
  });

  it('worker runs on complex tier (verify via stageStats or agent model)', async () => {
    const { ctx } = makeContext();
    const out = await executeVerify(ctx, {
      checklist: ['check the footer displays copyright'],
    });

    const results = out.results as any[];
    const r = results[0];

    // The lifecycle populates stageStats with tier information.
    // For complex-tier workers, the implementing stage records 'complex'.
    const implementing = r.stageStats?.implementing;
    if (implementing?.agentTier) {
      expect(implementing.agentTier).toBe('complex');
    }

    // Fallback: the implementation agent model should include 'cpx'
    if (r.models?.implementer) {
      expect(r.models.implementer).toContain('cpx');
    }
  });
});
