import { describe, expect, it } from 'vitest';
import { inputSchema } from '../../packages/core/src/tools/explore/schema.js';

describe('explore inputSchema', () => {
  const baseValid = {
    currentContext: 'a'.repeat(20),
    explorationQuestion: 'b'.repeat(20),
  };

  it('accepts a valid minimal request', () => {
    const r = inputSchema.parse(baseValid);
    expect(r.currentContext.length).toBe(20);
    expect(r.anchors).toEqual([]);
    expect(r.contextBlockIds).toEqual([]);
  });

  it('rejects currentContext < 20 chars', () => {
    expect(() => inputSchema.parse({ ...baseValid, currentContext: 'short' })).toThrow();
  });

  it('rejects currentContext > 8000 chars', () => {
    expect(() => inputSchema.parse({ ...baseValid, currentContext: 'x'.repeat(8001) })).toThrow();
  });

  it('rejects > 32 anchors', () => {
    expect(() => inputSchema.parse({ ...baseValid, anchors: Array(33).fill('a') })).toThrow();
  });

  it('rejects anchor entries > 512 chars', () => {
    expect(() => inputSchema.parse({ ...baseValid, anchors: ['a'.repeat(513)] })).toThrow();
  });

  it('rejects > 16 contextBlockIds', () => {
    expect(() => inputSchema.parse({ ...baseValid, contextBlockIds: Array(17).fill('id') })).toThrow();
  });

  it('rejects agentType (tier_not_overridable)', () => {
    expect(() => inputSchema.parse({ ...baseValid, agentType: 'simple' })).toThrow(/tier_not_overridable/);
  });

  it('rejects tools (tool_surface_not_overridable)', () => {
    expect(() => inputSchema.parse({ ...baseValid, tools: 'full' })).toThrow(/tool_surface_not_overridable/);
  });

  it('rejects unknown top-level fields with unknown_field', () => {
    expect(() => inputSchema.parse({ ...baseValid, threadCount: 5 })).toThrow(/unknown_field/);
  });

  it('trims whitespace before length check', () => {
    const r = inputSchema.parse({ ...baseValid, currentContext: '   ' + 'a'.repeat(20) + '   ' });
    expect(r.currentContext).toBe('a'.repeat(20));
  });
});
