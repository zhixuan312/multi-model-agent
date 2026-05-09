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

  it('includes the debug failure-mode taxonomy', () => {
    const briefs = toolConfig.briefSlot({ problem: 'crash on login', filePaths: ['/x/auth.ts'], contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    // All 9 categories should each surface in the worker's prompt.
    expect(spec.prompt).toContain('SYMPTOM-NOT-CAUSE');
    expect(spec.prompt).toContain('SCAPEGOAT FILE');
    expect(spec.prompt).toContain('INCOMPLETE TRACE');
    expect(spec.prompt).toContain('UNTESTED HYPOTHESIS');
    expect(spec.prompt).toContain('PARALLEL CAUSES');
    expect(spec.prompt).toContain('PRE-EXISTING-VS-NEW ENTANGLEMENT');
    expect(spec.prompt).toContain('WRONG FIX SCOPE');
    expect(spec.prompt).toContain('MISSING REPRODUCTION');
    expect(spec.prompt).toContain('CONFIDENCE OVERSTATEMENT');
  });

  it('includes the symptom-cause walk with worked example', () => {
    const briefs = toolConfig.briefSlot({ problem: 'crash on login', filePaths: ['/x/auth.ts'], contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('Symptom → cause walk');
    expect(spec.prompt).toContain('Worked example');
  });
});
