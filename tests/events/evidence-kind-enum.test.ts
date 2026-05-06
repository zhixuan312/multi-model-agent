import { describe, it, expect } from 'vitest';
import { EvidenceKindEnum } from '../../packages/core/src/types/enums.js';

describe('EvidenceKindEnum', () => {
  it('accepts the three spec values', () => {
    for (const v of ['reproducer', 'code_path', 'fix'] as const) {
      expect(() => EvidenceKindEnum.parse(v)).not.toThrow();
    }
  });
  it('rejects unknown values', () => {
    expect(() => EvidenceKindEnum.parse('explanation')).toThrow();
  });
});
