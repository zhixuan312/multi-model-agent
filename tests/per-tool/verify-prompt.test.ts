import { describe, it, expect } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/verify/tool-config.js';
import type { ExecutionContext } from '../../packages/core/src/lifecycle/lifecycle-context.js';

const ctx = {
  cwd: '/tmp',
  config: { defaults: {} },
  projectContext: undefined,
  mainModel: undefined,
} as unknown as ExecutionContext;

describe('verify prompt content', () => {
  it('binds severity to PASS=low / FAIL=medium-high and demands 1:1 mapping', () => {
    const briefs = toolConfig.briefSlot({ work: 'build', checklist: ['unit tests pass', 'lint passes'], filePaths: [], contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('PASS = low');
    expect(spec.prompt).toContain('1:1 to a checklist item');
  });

  it('opens with the false-claim-gate orientation block', () => {
    const briefs = toolConfig.briefSlot({ work: 'build', checklist: ['unit tests pass'], filePaths: [], contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('"are we lying when we say it is done?"');
    expect(spec.prompt).toContain('rubber stamp');
  });

  it('includes the 5 verify evidence sources', () => {
    const briefs = toolConfig.briefSlot({ work: 'build', checklist: ['unit tests pass'], filePaths: [], contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    // 5 parallel evidence sources; each sub-worker takes one.
    expect(spec.prompt).toContain('TEST-SUITE EVIDENCE');
    expect(spec.prompt).toContain('SOURCE-CODE DIRECT-READ');
    expect(spec.prompt).toContain('DOCUMENTATION EVIDENCE');
    expect(spec.prompt).toContain('RUN-OUTPUT EVIDENCE');
    expect(spec.prompt).toContain('DIFF EVIDENCE');
  });

  it('accepts NEGATIVE evidence as a valid third shape', () => {
    const briefs = toolConfig.briefSlot({ work: 'build', checklist: ['unit tests pass'], filePaths: [], contextBlockIds: [] } as any);
    const spec = toolConfig.buildTaskSpec(briefs[0], ctx);
    expect(spec.prompt).toContain('NEGATIVE');
    expect(spec.prompt).toContain('cannot verify from this artifact');
  });
});
