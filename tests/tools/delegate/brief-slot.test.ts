import { describe, it, expect } from 'vitest';
import { delegateBriefSlot } from '../../../packages/core/src/tools/delegate/brief-slot.js';
import { toolConfig } from '../../../packages/core/src/tools/delegate/tool-config.js';
import { inputSchema } from '../../../packages/core/src/tools/delegate/schema.js';

const ctx = { cwd: '/tmp', projectContext: { cwd: '/tmp' }, config: { defaults: {} } } as any;

// Goal mode: /delegate compiles ONE goal-set brief whose tasks are the caller's
// tasks. The implement prompt is materialized in buildTaskSpec.
describe('delegateBriefSlot — goal-set construction', () => {
  it('returns exactly one brief regardless of task count, one GoalTask per task', () => {
    const briefs = delegateBriefSlot(inputSchema.parse({
      tasks: [{ prompt: 'a' }, { prompt: 'b' }],
    }));
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.tasks).toHaveLength(2);
  });

  it('derives phase-1 tier complex if any task is complex, else standard', () => {
    const stdOnly = delegateBriefSlot(inputSchema.parse({ tasks: [{ prompt: 'a' }] }));
    expect(stdOnly[0]!.phase1Tier).toBe('standard');
    const withComplex = delegateBriefSlot(inputSchema.parse({
      tasks: [{ prompt: 'a' }, { prompt: 'b', agentType: 'complex' }],
    }));
    expect(withComplex[0]!.phase1Tier).toBe('complex');
  });

  it('reviewPolicy collapses to none only when every task opts out', () => {
    const allNone = delegateBriefSlot(inputSchema.parse({
      tasks: [{ prompt: 'a', reviewPolicy: 'none' }, { prompt: 'b', reviewPolicy: 'none' }],
    }));
    expect(allNone[0]!.reviewPolicy).toBe('none');
    const someReview = delegateBriefSlot(inputSchema.parse({
      tasks: [{ prompt: 'a', reviewPolicy: 'none' }, { prompt: 'b' }],
    }));
    expect(someReview[0]!.reviewPolicy).toBe('review-fix');
  });

  it('task body carries the caller brief, scope rule, and failure modes', () => {
    const briefs = delegateBriefSlot(inputSchema.parse({ tasks: [{ prompt: 'add util.clamp' }] }));
    const body = briefs[0]!.tasks[0]!.body;
    expect(body).toContain('add util.clamp');
    expect(body).toContain('Scope:');
    expect(body).toContain('SCOPE CREEP');
  });

  it('strengthens the file constraint when filePaths is set, omits it otherwise', () => {
    const withPaths = delegateBriefSlot(inputSchema.parse({
      tasks: [{ prompt: 'x', filePaths: ['src/util.ts'] }],
    }))[0]!.tasks[0]!.body;
    expect(withPaths).toContain('src/util.ts');
    const without = delegateBriefSlot(inputSchema.parse({ tasks: [{ prompt: 'x' }] }))[0]!.tasks[0]!.body;
    expect(without).not.toContain('Write to exactly these path');
  });
});

describe('delegate goal prompt (via buildTaskSpec)', () => {
  it('materializes the implement prompt with the goal conventions', () => {
    const briefs = delegateBriefSlot(inputSchema.parse({ tasks: [{ prompt: 'add util.clamp' }] }));
    const spec = toolConfig.buildTaskSpec(briefs[0]!, ctx);
    expect(spec.goal).toBeDefined();
    expect(spec.prompt).toContain('[task N]');                 // commit convention
    expect(spec.prompt).toContain('PROHIBITED git operations'); // bounded git surface
    expect(spec.prompt).toMatch(/```json/);                     // structured summary
    expect(spec.prompt).toContain('add util.clamp');            // the task body
  });
});
