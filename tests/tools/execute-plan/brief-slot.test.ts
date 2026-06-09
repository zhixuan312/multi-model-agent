import { describe, it, expect } from 'vitest';
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
  const dir = join(tmpdir(), `execplan-goal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Goal mode: ONE brief whose tasks are the matched plan sections; per-task
// review policy collapses to the goal axis.
describe('executePlanBriefSlot', () => {
  it('extracts each named section into a GoalTask', () => {
    const cwd = makeTempCwd();
    try {
      writeFileSync(join(cwd, 'plan.md'), FIXTURE_PLAN);
      const briefs = executePlanBriefSlot({
        filePaths: ['plan.md'],
        taskDescriptors: ['Task 1: Do something'],
        cwd,
      });
      expect(briefs).toHaveLength(1);
      expect(briefs[0]!.tasks).toHaveLength(1);
      expect(briefs[0]!.tasks[0]!.heading).toBe('Task 1: Do something');
      expect(briefs[0]!.tasks[0]!.body).toContain('Step body here.');
      expect(briefs[0]!.filePaths).toEqual(['plan.md']);
      expect(briefs[0]!.cwd).toBe(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('collapses perTaskReviewPolicy: review-fix unless every task opts out', () => {
    const cwd = makeTempCwd();
    try {
      writeFileSync(join(cwd, 'plan.md'), FIXTURE_PLAN);
      const someReview = executePlanBriefSlot({
        filePaths: ['plan.md'],
        taskDescriptors: ['Task 1: Do something', 'Task 2: Another thing'],
        cwd,
        perTaskReviewPolicy: { '0': 'none', '1': 'quality_only' },
      });
      expect(someReview[0]!.reviewPolicy).toBe('review-fix');
      const allNone = executePlanBriefSlot({
        filePaths: ['plan.md'],
        taskDescriptors: ['Task 1: Do something', 'Task 2: Another thing'],
        cwd,
        perTaskReviewPolicy: { '0': 'none', '1': 'none' },
      });
      expect(allNone[0]!.reviewPolicy).toBe('none');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('defaults reviewPolicy to "review-fix" when not specified', () => {
    const cwd = makeTempCwd();
    try {
      writeFileSync(join(cwd, 'plan.md'), FIXTURE_PLAN);
      const briefs = executePlanBriefSlot({
        filePaths: ['plan.md'],
        taskDescriptors: ['Task 1: Do something'],
        cwd,
      });
      expect(briefs[0]!.reviewPolicy).toBe('review-fix');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('truncates sections larger than the 30 KB cap (SLICE_CAP_BYTES)', () => {
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
      // Truncated body keeps the cap (plus the appended truncation note).
      expect(briefs[0]!.tasks[0]!.body).toContain('Section truncated');
      expect(briefs[0]!.tasks[0]!.body.length).toBeLessThanOrEqual(31 * 1024);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
