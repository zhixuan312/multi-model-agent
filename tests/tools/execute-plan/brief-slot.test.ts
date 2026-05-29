import { describe, it, expect } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePlanBriefSlot } from '../../../packages/core/src/tools/execute-plan/brief-slot.js';

const FIXTURE_PLAN = `# Test Plan

### Task 1: Do something
Step body here.

### Task 2: Another thing
Body for task 2.
`;

function makeTempCwd(): string {
  const dir = join(tmpdir(), `intake-pr2-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('executePlanBriefSlot', () => {
  it('extracts a named section into a brief', () => {
    const cwd = makeTempCwd();
    try {
      writeFileSync(join(cwd, 'plan.md'), FIXTURE_PLAN);
      const briefs = executePlanBriefSlot({
        filePaths: ['plan.md'],
        taskDescriptors: ['Task 1: Do something'],
        cwd,
      });
      expect(briefs).toHaveLength(1);
      expect(briefs[0].taskDescriptor).toBe('Task 1: Do something');
      expect(briefs[0].sectionBody).toContain('Step body here.');
      expect(briefs[0].sectionTruncated).toBe(false);
      expect(briefs[0].filePaths).toEqual(['plan.md']);
      expect(briefs[0].cwd).toBe(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('applies perTaskReviewPolicy per task index', () => {
    const cwd = makeTempCwd();
    try {
      writeFileSync(join(cwd, 'plan.md'), FIXTURE_PLAN);
      const briefs = executePlanBriefSlot({
        filePaths: ['plan.md'],
        taskDescriptors: ['Task 1: Do something', 'Task 2: Another thing'],
        cwd,
        perTaskReviewPolicy: { '0': 'none', '1': 'quality_only' },
      });
      expect(briefs).toHaveLength(2);
      expect(briefs[0].reviewPolicy).toBe('none');
      expect(briefs[1].reviewPolicy).toBe('quality_only');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('defaults reviewPolicy to "full" when not specified', () => {
    const cwd = makeTempCwd();
    try {
      writeFileSync(join(cwd, 'plan.md'), FIXTURE_PLAN);
      const briefs = executePlanBriefSlot({
        filePaths: ['plan.md'],
        taskDescriptors: ['Task 1: Do something'],
        cwd,
      });
      expect(briefs[0].reviewPolicy).toBe('full');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('truncates sections larger than 30 KB cap (SLICE_CAP_BYTES)', () => {
    const cwd = makeTempCwd();
    try {
      const big = 'x'.repeat(35 * 1024);
      const plan = `### Task 1: Big task\n${big}\n`;
      writeFileSync(join(cwd, 'plan.md'), plan);
      const briefs = executePlanBriefSlot({
        filePaths: ['plan.md'],
        taskDescriptors: ['Task 1: Big task'],
        cwd,
      });
      expect(briefs[0].sectionTruncated).toBe(true);
      expect(briefs[0].sectionBody.length).toBeLessThanOrEqual(30 * 1024);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
