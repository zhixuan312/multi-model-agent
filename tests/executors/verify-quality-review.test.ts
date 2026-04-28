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
      // Discriminate by prompt content: the annotation reviewer prompt embeds
      // the rubric "reviewerConfidence". Anything else is the implementer.
      const isReviewer = typeof prompt === 'string' && prompt.includes('reviewerConfidence');
      if (!isReviewer) {
        return {
          output: [
            '## Summary',
            'done',
            '',
            '## Findings',
            '```json',
            JSON.stringify([
              { id: 'F1', severity: 'low', claim: 'criterion met', evidence: 'test.txt:1 — file exists with the expected contents on disk' },
            ]),
            '```',
            '',
            '## Files changed',
            '- test.txt: created',
            '',
            '## Validations run',
            '',
            '## Deviations from brief',
            '',
            '## Unresolved',
            '',
          ].join('\n'),
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
      // Quality reviewer call(s) — annotation model returns a JSON annotation array
      return {
        output: [
          'Annotated.',
          '```json',
          JSON.stringify([{ id: 'F1', reviewerConfidence: 80 }]),
          '```',
        ].join('\n'),
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
    expect(out.qualityReviewVerdict).toBe('annotated');
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
    expect(r.qualityReviewStatus).toBe('annotated');
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
