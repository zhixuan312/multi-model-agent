import { describe, it, expect } from 'vitest';
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
  const spec = toolConfig.buildTaskSpec(briefs[0]!, ctx);
  return spec.prompt;
}

// Goal mode: the implement prompt is the whole-plan goal prompt.
describe('execute-plan goal implement prompt', () => {
  it('opens with the autonomous-executor orientation', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const prompt = buildPrompt(tmp);
      expect(prompt).toContain('autonomous executor of a multi-task plan');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('includes the 4-failure-mode taxonomy', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const prompt = buildPrompt(tmp);
      expect(prompt).toContain('CODE SUBSTITUTION');
      expect(prompt).toContain('STEP SKIP');
      expect(prompt).toContain('PLAN REWRITE');
      expect(prompt).toContain('PROBLEM-NOT-FLAGGED');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('carries the per-task commit convention and a worked example', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const prompt = buildPrompt(tmp);
      expect(prompt).toContain('[task N]');
      expect(prompt).toContain('git commit -m');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prohibits destructive git operations', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const prompt = buildPrompt(tmp);
      expect(prompt).toContain('PROHIBITED git operations');
      expect(prompt).toMatch(/reset --hard/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('requires the structured-summary JSON block and embeds the plan section', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const prompt = buildPrompt(tmp);
      expect(prompt).toMatch(/```json/);
      expect(prompt).toContain('clamp(x, min, max)');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
