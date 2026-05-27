import { describe, it, expect } from 'bun:test';
import { auditBriefSlot } from '../../../packages/core/src/tools/audit/brief-slot.js';

describe('auditBriefSlot', () => {
  it('returns one brief with inline document when document is provided', () => {
    const briefs = auditBriefSlot({
      subtype: 'default',
      document: 'Some prose to audit',
      filePaths: [],
      contextBlockIds: [],
    } as any);
    expect(briefs).toHaveLength(1);
    expect(briefs[0].document).toBe('Some prose to audit');
    expect(briefs[0].filePaths).toEqual([]);
    expect(briefs[0].hasContextBlocks).toBe(false);
  });

  it('fans out one brief per filePath when no document + 2+ paths', () => {
    const briefs = auditBriefSlot({
      subtype: 'default',
      filePaths: ['/p/a.md', '/p/b.md'],
      contextBlockIds: [],
    } as any);
    expect(briefs).toHaveLength(2);
    expect(briefs[0].perFilePath).toBe('/p/a.md');
    expect(briefs[1].perFilePath).toBe('/p/b.md');
    expect(briefs[0].filePaths).toEqual(['/p/a.md']);
  });

  it('reflects subtype in subtypeText', () => {
    const briefs = auditBriefSlot({
      subtype: 'spec',
      document: 'A spec to audit',
      filePaths: [],
      contextBlockIds: [],
    } as any);
    expect(briefs[0].subtypeText).toContain('requirement');
    expect(briefs[0].subtype).toBe('spec');
  });

  it('sets hasContextBlocks=true when contextBlockIds non-empty', () => {
    const briefs = auditBriefSlot({
      subtype: 'default',
      document: 'X',
      filePaths: [],
      contextBlockIds: ['cb-1'],
    } as any);
    expect(briefs[0].hasContextBlocks).toBe(true);
    expect(briefs[0].contextBlockIds).toEqual(['cb-1']);
  });

  it('treats empty/undefined subtype as default', () => {
    const briefs = auditBriefSlot({
      document: 'X',
      filePaths: [],
      contextBlockIds: [],
    } as any);
    expect(briefs[0].subtypeText).toContain('prose-coherence');
  });
});
