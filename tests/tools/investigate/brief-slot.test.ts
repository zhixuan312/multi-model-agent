import { describe, it, expect } from 'bun:test';
import { investigateBriefSlot } from '../../../packages/core/src/tools/investigate/brief-slot.js';

const baseInput = {
  question: 'How does X work?',
  filePaths: [] as string[],
  contextBlockIds: [] as string[],
  tools: 'readonly' as const,
  subtype: 'default',
  // enriched field
  canonicalizedFilePaths: [],
};

describe('investigateBriefSlot', () => {
  it('returns one brief carrying the question', () => {
    const briefs = investigateBriefSlot({ ...baseInput } as any);
    expect(briefs).toHaveLength(1);
    expect(briefs[0].question).toBe('How does X work?');
  });

  it('forwards canonicalizedFilePaths into brief.filePaths', () => {
    const briefs = investigateBriefSlot({
      ...baseInput,
      canonicalizedFilePaths: ['/abs/foo.ts'],
    } as any);
    expect(briefs[0].filePaths).toEqual(['/abs/foo.ts']);
  });

  it('forwards contextBlockIds into the brief', () => {
    const briefs = investigateBriefSlot({
      ...baseInput,
      contextBlockIds: ['cb-1', 'cb-2'],
    } as any);
    expect(briefs[0].contextBlockIds).toEqual(['cb-1', 'cb-2']);
  });

  it('forwards tools setting onto the brief', () => {
    const briefs = investigateBriefSlot({
      ...baseInput,
      tools: 'none',
    } as any);
    expect(briefs[0].tools).toBe('none');
  });
});
