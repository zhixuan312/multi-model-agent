import { describe, expect, it } from 'vitest';
import { WRITING_STYLE_BLOCK } from '../../../packages/core/src/unified/writing-style-block.js';
import { TASK_TYPES, TYPE_REGISTRY } from '../../../packages/core/src/unified/type-registry.js';

describe('shared writing-style block', () => {
  it('contains every required safeguard, no forbidden prompt literals, and the approved word range', () => {
    expect(WRITING_STYLE_BLOCK).toContain('ASD-STE100 Simplified Technical English');
    expect(WRITING_STYLE_BLOCK).toContain('style guidance, not a claim of ASD-STE100 compliance');
    expect(WRITING_STYLE_BLOCK).toContain('Do not restrict wording to the ASD-STE100 controlled dictionary');
    expect(WRITING_STYLE_BLOCK).toContain('Do not enforce its formal sentence-length limits');
    expect(WRITING_STYLE_BLOCK).toContain('Never remove a fact, condition, assumption, limitation, risk, or trade-off merely to shorten text');
    expect(WRITING_STYLE_BLOCK).toContain('a heading that another tool matches, a file path, an identifier, code, a command, a configuration value, a schema field name, an API name, a protocol name, or an exact quotation');
    expect(WRITING_STYLE_BLOCK).toContain("the skill's own statement wins");
    expect(WRITING_STYLE_BLOCK).toContain('Write professional, natural prose');
    expect(WRITING_STYLE_BLOCK).toContain('childish, robotic, or artificially simplified');
    expect(WRITING_STYLE_BLOCK).toContain('what was decided, why, what problem it solves, what changes in practice, and what limitation or trade-off remains');
    expect(WRITING_STYLE_BLOCK).not.toContain('Decision Records');
    expect(WRITING_STYLE_BLOCK).not.toContain('Acceptance Criteria');
    expect(WRITING_STYLE_BLOCK.trim().split(/\s+/).length).toBeGreaterThanOrEqual(270);
    expect(WRITING_STYLE_BLOCK.trim().split(/\s+/).length).toBeLessThanOrEqual(360);
  });

  it('requires and explicitly classifies every registry task type', () => {
    const readerFacing = new Set(['audit', 'investigate', 'review', 'debug', 'research', 'journal_recall', 'journal_record', 'spec', 'plan']);
    expect(TASK_TYPES).toHaveLength(12);
    for (const type of TASK_TYPES) expect(TYPE_REGISTRY[type].readerFacing).toBe(readerFacing.has(type));
  });
});