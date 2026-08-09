import { describe, expect, it } from 'vitest';
import { parseContractPlan } from '@zhixuan92/multi-model-agent-core';

describe('deliverable-neutral Contract Task grammar', () => {
  it('accepts a task with output and dependencies but no deterministic check', () => {
    const plan = `### Task I-1: Prepare report\n\n**Output:** \`out/report.pdf\`\n**Dependencies:** approved figures\n\n**Contract:**\n- Inputs / Request: reconciled figures\n- Outputs / Response: report file\n- Data mapping: figures to tables\n- Errors: missing figure blocks task\n- Behavior / invariants: preserve approved values\n\n**Plan boundary:** final deliverable content is not in this plan.`;
    const task = parseContractPlan(plan).tasks[0];
    expect(task.id).toBe('I-1');
    expect(task.acceptanceTests).toEqual([]);
  });
});