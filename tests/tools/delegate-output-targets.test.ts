import { describe, it, expect } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/delegate/tool-config.js';
import { delegateBriefSlot } from '../../packages/core/src/tools/delegate/brief-slot.js';

const ctx = { cwd: '/tmp', projectContext: { cwd: '/tmp' }, config: { defaults: {} } } as any;

// Goal mode: outputTargets are folded into the task body (the agent is told to
// produce them) rather than a separate TaskSpec field — there is one goal-set
// TaskSpec spanning all tasks, so per-task output targets ride in the planText.
describe('delegate outputTargets wiring', () => {
  it('surfaces outputTargets in the goal planText', () => {
    const briefs = delegateBriefSlot({ tasks: [{ prompt: 'do x', outputTargets: ['out/a.ts'] }] } as any);
    expect(briefs[0]!.tasks[0]!.body).toMatch(/out\/a\.ts/);
    const spec = toolConfig.buildTaskSpec(briefs[0]!, ctx);
    expect(spec.goal!.planText).toMatch(/out\/a\.ts/);
  });

  it('omits the output-target clause when not supplied', () => {
    const briefs = delegateBriefSlot({ tasks: [{ prompt: 'do x' }] } as any);
    expect(briefs[0]!.tasks[0]!.body).not.toMatch(/MUST produce these output file/);
  });
});
