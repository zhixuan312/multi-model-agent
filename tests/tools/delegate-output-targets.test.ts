import { describe, it, expect } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/delegate/tool-config.js';
import { delegateBriefSlot } from '../../packages/core/src/tools/delegate/brief-slot.js';

const ctx = { cwd: '/tmp', projectContext: { cwd: '/tmp' }, config: { defaults: {} } } as any;

describe('delegate outputTargets wiring', () => {
  it('forwards outputTargets input → brief → TaskSpec', () => {
    const briefs = delegateBriefSlot({ tasks: [{ prompt: 'do x', outputTargets: ['out/a.ts'] }] } as any);
    expect(briefs[0].outputTargets).toEqual(['out/a.ts']);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.outputTargets).toEqual(['out/a.ts']);
  });

  it('leaves outputTargets undefined when not supplied', () => {
    const briefs = delegateBriefSlot({ tasks: [{ prompt: 'do x' }] } as any);
    expect(briefs[0].outputTargets).toBeUndefined();
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.outputTargets).toBeUndefined();
  });
});
