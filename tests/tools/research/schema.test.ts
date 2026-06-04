import { describe, expect, it } from 'vitest';
import { inputSchema } from '../../../packages/core/src/tools/research/schema.js';

describe('research inputSchema', () => {
  const minValid = {
    researchQuestion: 'What are state-of-the-art approaches to streaming JSON parsers?',
    background: 'We currently use a single-pass push parser; we want to evaluate alternatives.',
  };

  it('accepts a minimal valid input (contextBlockIds defaults to [])', () => {
    const result = inputSchema.safeParse(minValid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.researchQuestion).toContain('streaming JSON');
      expect(result.data.background).toContain('single-pass');
      expect(result.data.contextBlockIds).toEqual([]);
    }
  });

  it('accepts contextBlockIds when supplied', () => {
    const result = inputSchema.safeParse({ ...minValid, contextBlockIds: ['blk_1', 'blk_2'] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.contextBlockIds).toEqual(['blk_1', 'blk_2']);
  });

  it('rejects researchQuestion shorter than 20 chars', () => {
    const result = inputSchema.safeParse({ ...minValid, researchQuestion: 'too short' });
    expect(result.success).toBe(false);
  });

  it('rejects background shorter than 20 chars', () => {
    const result = inputSchema.safeParse({ ...minValid, background: 'short' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown key with code unknown_field', () => {
    const result = inputSchema.safeParse({ ...minValid, foo: 'bar' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message === 'unknown_field' && i.path[0] === 'foo')).toBe(true);
    }
  });

  it('rejects agentType with code tier_not_overridable', () => {
    const result = inputSchema.safeParse({ ...minValid, agentType: 'simple' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message === 'tier_not_overridable' && i.path[0] === 'agentType')).toBe(true);
    }
  });

  it('rejects tools with code tool_surface_not_overridable', () => {
    const result = inputSchema.safeParse({ ...minValid, tools: 'full' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message === 'tool_surface_not_overridable' && i.path[0] === 'tools')).toBe(true);
    }
  });

  it('rejects non-object body', () => {
    const result = inputSchema.safeParse('not an object');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('body must be an object'))).toBe(true);
    }
  });

  it('emits blocked-key issues before unknown-key issues (deterministic order)', () => {
    const result = inputSchema.safeParse({ ...minValid, foo: 'x', agentType: 'simple', tools: 'full' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      const idxAgent = messages.indexOf('tier_not_overridable');
      const idxTools = messages.indexOf('tool_surface_not_overridable');
      const idxFoo = messages.indexOf('unknown_field');
      expect(idxAgent).toBeLessThan(idxTools);
      expect(idxTools).toBeLessThan(idxFoo);
    }
  });
});
