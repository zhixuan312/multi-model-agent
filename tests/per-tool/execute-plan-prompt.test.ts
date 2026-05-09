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

describe('execute-plan prompt content', () => {
  it('opens with the fidelity-first orientation block', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const planPath = makePlan(tmp);
      const briefs = toolConfig.briefSlot({
        filePaths: [planPath],
        taskDescriptors: ['Step 1: create util'],
        cwd: tmp,
      } as any);
      const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
      expect(spec.prompt).toContain('Why this execution exists');
      expect(spec.prompt).toContain('Your job is execution, not improvement');
      expect(spec.prompt).toContain('Follow the plan EXACTLY as written');
      expect(spec.prompt).toContain('use them VERBATIM');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('includes the execute-plan failure-mode taxonomy', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const planPath = makePlan(tmp);
      const briefs = toolConfig.briefSlot({
        filePaths: [planPath],
        taskDescriptors: ['Step 1: create util'],
        cwd: tmp,
      } as any);
      const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
      // All 9 categories.
      expect(spec.prompt).toContain('PLAN REWRITE');
      expect(spec.prompt).toContain('STEP SKIP');
      expect(spec.prompt).toContain('STEP REORDER');
      expect(spec.prompt).toContain('CODE SUBSTITUTION');
      expect(spec.prompt).toContain('ACCEPTANCE-CRITERIA OVERRUN');
      expect(spec.prompt).toContain('ACCEPTANCE-CRITERIA UNDERRUN');
      expect(spec.prompt).toContain('WRONG-TASK MATCH');
      expect(spec.prompt).toContain('CROSS-TASK CONTAMINATION');
      expect(spec.prompt).toContain('PROBLEM-NOT-FLAGGED');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('restores the dropped fidelity lines (verbatim, no redesign, no substitution)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const planPath = makePlan(tmp);
      const briefs = toolConfig.briefSlot({
        filePaths: [planPath],
        taskDescriptors: ['Step 1: create util'],
        cwd: tmp,
      } as any);
      const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
      // These lines were in the older compileExecutePlan and dropped by the
      // slot-style refactor. 4.1.0 restores them inside the orientation.
      expect(spec.prompt).toContain('Do NOT redesign');
      expect(spec.prompt).toContain('Do NOT substitute your own approach');
      expect(spec.prompt).toContain('written by a higher-capability model');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('includes the code-block faithfulness walk with worked example', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mma-execplan-prompt-'));
    try {
      const planPath = makePlan(tmp);
      const briefs = toolConfig.briefSlot({
        filePaths: [planPath],
        taskDescriptors: ['Step 1: create util'],
        cwd: tmp,
      } as any);
      const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
      expect(spec.prompt).toContain('Code-block faithfulness walk');
      expect(spec.prompt).toContain('Worked example');
      expect(spec.prompt).toContain('parseTokens');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
