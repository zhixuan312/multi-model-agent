import { describe, it, expect } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/debug/tool-config.js';
import type { ExecutionContext } from '../../packages/core/src/lifecycle/lifecycle-context.js';

const ctx = {
  cwd: '/tmp',
  config: { defaults: {} },
  projectContext: undefined,
  mainModel: undefined,
} as unknown as ExecutionContext;

describe('debug prompt content', () => {
  it('allows partial-evidence hypotheses and requires cross-file tracing', () => {
    const briefs = toolConfig.briefSlot({ problem: 'crash on login', filePaths: ['/x/auth.ts'], contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('PARTIAL evidence are valid');
    expect(spec.prompt).toContain('Cross-file tracing is required');
    expect(spec.prompt).toContain('propose, do not apply');
  });

  it('opens with the symptom-vs-cause orientation block', () => {
    const briefs = toolConfig.briefSlot({ problem: 'crash on login', filePaths: ['/x/auth.ts'], contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('replaces the maintainer\'s own root-cause work');
    expect(spec.prompt).toContain('Reproduction:');
    expect(spec.prompt).toContain('Symptom:');
    expect(spec.prompt).toContain('Cause:');
    expect(spec.prompt).toContain('Falsifier:');
  });

  it('includes the 5 debug root-cause angles', () => {
    const briefs = toolConfig.briefSlot({ problem: 'crash on login', filePaths: ['/x/auth.ts'], contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    // 5 parallel angles for finding root cause; each sub-worker takes one.
    expect(spec.prompt).toContain('SYMPTOM-LOCATION ANGLE');
    expect(spec.prompt).toContain('RECENT-CHANGE ANGLE');
    expect(spec.prompt).toContain('TEST-FAILURE ANGLE');
    expect(spec.prompt).toContain('REPRODUCTION ANGLE');
    expect(spec.prompt).toContain('CONCURRENCY / CONFIGURATION ANGLE');
  });

  it('includes the symptom-cause walk with worked example', () => {
    const briefs = toolConfig.briefSlot({ problem: 'crash on login', filePaths: ['/x/auth.ts'], contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('Symptom → cause walk');
    expect(spec.prompt).toContain('Worked example');
  });
});
