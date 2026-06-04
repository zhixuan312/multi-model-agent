import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/execute-plan/tool-config.js';
import { executePlanBriefSlot } from '../../packages/core/src/tools/execute-plan/brief-slot.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const testDir = '/tmp/execute-plan-test';
const planFile = join(testDir, 'test-plan.md');

describe('execute-plan TaskSpec plumbing', () => {
  beforeAll(() => {
    // Create test directory and plan file
    mkdirSync(testDir, { recursive: true });
    const planContent = `# Test Plan

## Task 3: add buildCancelledResult helper

Some task description here.

### Step 1
Do something.

### Step 2
Do something else.
`;
    writeFileSync(planFile, planContent, 'utf8');
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('builds TaskSpec with taskDescriptor and planBasename from plan heading', () => {
    const briefs = executePlanBriefSlot({
      filePaths: [planFile],
      taskDescriptors: ['Task 3: add buildCancelledResult helper'],
      cwd: testDir,
    });

    expect(briefs).toHaveLength(1);
    const brief = briefs[0];
    expect(brief.taskDescriptor).toBe('Task 3: add buildCancelledResult helper');

    const ctx = { cwd: testDir, projectContext: { cwd: testDir }, config: { defaults: {} } } as any;
    const spec = toolConfig.buildTaskSpec(brief, ctx);

    expect(spec.taskDescriptor).toBe('Task 3: add buildCancelledResult helper');
    expect(spec.planBasename).toBe('test-plan.md');
  });
});
