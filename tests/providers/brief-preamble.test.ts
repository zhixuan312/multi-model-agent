import { describe, it, expect } from 'vitest';
import { COMMIT_BLOCK_GUIDANCE, buildFormatConstraintSuffix } from '../../packages/core/src/providers/brief-preamble.js';

describe('brief-preamble', () => {
  it('COMMIT_BLOCK_GUIDANCE includes the JSON shape', () => {
    expect(COMMIT_BLOCK_GUIDANCE).toContain('"type":');
    expect(COMMIT_BLOCK_GUIDANCE).toContain('"subject":');
  });
  it('buildFormatConstraintSuffix is empty for empty input', () => {
    expect(buildFormatConstraintSuffix({})).toBe('');
  });
  it('buildFormatConstraintSuffix renders both fields', () => {
    expect(buildFormatConstraintSuffix({ inputFormat: 'json', outputFormat: 'yaml' }))
      .toContain('input format: json');
  });
});
