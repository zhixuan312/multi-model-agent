import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/execute-plan/tool-config.js';
import { executePlanBriefSlot } from '../../packages/core/src/tools/execute-plan/brief-slot.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const testDir = '/tmp/execute-plan-test';
const planFile = join(testDir, 'test-plan.md');

// Goal mode: execute-plan builds ONE goal-set whose tasks are the matched plan
// sections; the implement prompt is materialized into TaskSpec.prompt and the
// Goal rides on TaskSpec.goal.
describe('execute-plan TaskSpec plumbing', () => {
  beforeAll(() => {
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

  it('builds a goal TaskSpec with the descriptor as the task heading', () => {
    const briefs = executePlanBriefSlot({
      filePaths: [planFile],
      taskDescriptors: ['Task 3: add buildCancelledResult helper'],
      cwd: testDir,
    });

    expect(briefs).toHaveLength(1);
    const brief = briefs[0]!;
    expect(brief.tasks[0]!.heading).toBe('Task 3: add buildCancelledResult helper');

    const ctx = { cwd: testDir, projectContext: { cwd: testDir }, config: { defaults: {} } } as any;
    const spec = toolConfig.buildTaskSpec(brief, ctx);

    expect(spec.goal).toBeDefined();
    expect(spec.goal!.source).toBe('execute-plan');
    expect(spec.goal!.tasks[0]!.heading).toBe('Task 3: add buildCancelledResult helper');
    expect(spec.goal!.tasks[0]!.body).toMatch(/Some task description here/);
    // The implement prompt is materialized into prompt and carries the section.
    expect(spec.prompt).toMatch(/Some task description here/);
  });
});
