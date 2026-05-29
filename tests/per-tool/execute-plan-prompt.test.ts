import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toolConfig } from '../../packages/core/src/tools/execute-plan/tool-config.js';
import type { ExecutionContext } from '../../packages/core/src/lifecycle/lifecycle-context.js';

const ctx = {
  cwd: '/tmp',
  config: { defaults: {} },
  projectContext: undefined,
  mainModel: undefined,
} as unknown as ExecutionContext;

function makePlan(tmp: string): string {
  const planPath = join(tmp, 'PLAN.md');
  writeFileSync(planPath, [
    '# Plan',
    '',
    '## Step 1: create util',
    '',
    'Create `src/util.ts` exporting `clamp(x, min, max)`.',
    '',
  ].join('\n'), 'utf8');
  return planPath;
}

function buildPrompt(tmp: string): string {
  const planPath = makePlan(tmp);
  const briefs = toolConfig.briefSlot({
    filePaths: [planPath],
    taskDescriptors: ['Step 1: create util'],
    cwd: tmp,
  } as any);
  const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
  return spec.prompt;
}

describe('execute-plan prompt content (4.2.3 slim)', () => {
  it('opens with the mechanical-executor orientation', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const prompt = buildPrompt(tmp);
      expect(prompt).toContain('mechanical executor');
      expect(prompt).toContain('higher-capability model');
      expect(prompt).toContain('VERBATIM contracts');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('includes the slim 4-failure-mode taxonomy', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const prompt = buildPrompt(tmp);
      // 4.2.3 slim — top 4 modes calibrated from observed failures.
      expect(prompt).toContain('CODE SUBSTITUTION');
      expect(prompt).toContain('STEP SKIP');
      expect(prompt).toContain('PLAN REWRITE');
      expect(prompt).toContain('PROBLEM-NOT-FLAGGED');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('includes plan-vs-source reconciliation rule', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const prompt = buildPrompt(tmp);
      expect(prompt).toContain('Plan-vs-source reconciliation');
      expect(prompt).toContain('Reconciliations');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('includes self-verification requirement', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const prompt = buildPrompt(tmp);
      expect(prompt).toContain('Self-verification');
      expect(prompt).toContain('PASS / FAIL');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is significantly slimmer than the pre-4.2.3 prompt (under 8 KB)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const prompt = buildPrompt(tmp);
      // Pre-4.2.3 framing was ~16 KB before the section body.
      // Slim target: ~3 KB framing + section body.
      const bytes = Buffer.byteLength(prompt, 'utf8');
      expect(bytes).toBeLessThan(8 * 1024);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
