import { describe, it, expect } from 'vitest';
import {
  resolveDispatchMode,
  buildFilePathsPrompt,
  buildPerFilePrompt,
  validateInput,
} from '../../packages/mcp/src/tools/shared.js';

describe('resolveDispatchMode', () => {
  it('returns single when inline content is provided', () => {
    expect(resolveDispatchMode('content', ['a.ts', 'b.ts'])).toBe('single');
  });
  it('returns single when only 1 filePath and no content', () => {
    expect(resolveDispatchMode(undefined, ['a.ts'])).toBe('single');
  });
  it('returns fan_out when 2+ filePaths and no content', () => {
    expect(resolveDispatchMode(undefined, ['a.ts', 'b.ts'])).toBe('fan_out');
  });
  it('returns single when no content and empty filePaths', () => {
    expect(resolveDispatchMode(undefined, [])).toBe('single');
  });
  it('treats whitespace-only content as absent', () => {
    expect(resolveDispatchMode('   ', ['a.ts', 'b.ts'])).toBe('fan_out');
  });
  it('returns single when no filePaths at all', () => {
    expect(resolveDispatchMode(undefined, undefined)).toBe('single');
  });
});

describe('validateInput', () => {
  it('returns valid for non-empty trimmed content', () => {
    expect(validateInput('content', undefined)).toEqual({ valid: true });
  });
  it('returns valid for non-empty filePaths', () => {
    expect(validateInput(undefined, ['a.ts'])).toEqual({ valid: true });
  });
  it('returns invalid for neither content nor filePaths', () => {
    expect(validateInput(undefined, undefined).valid).toBe(false);
  });
  it('returns invalid for whitespace-only content and empty filePaths', () => {
    expect(validateInput('   ', []).valid).toBe(false);
  });
  it('returns invalid for empty strings in filePaths', () => {
    expect(validateInput('', ['  ', '']).valid).toBe(false);
  });
});

describe('buildFilePathsPrompt', () => {
  it('returns empty string for undefined', () => {
    expect(buildFilePathsPrompt(undefined)).toBe('');
  });
  it('returns empty string for empty array', () => {
    expect(buildFilePathsPrompt([])).toBe('');
  });
  it('returns formatted list', () => {
    const result = buildFilePathsPrompt(['src/a.ts', 'src/b.ts']);
    expect(result).toContain('Read and analyze these files:');
    expect(result).toContain('- src/a.ts');
    expect(result).toContain('- src/b.ts');
  });
});

describe('buildPerFilePrompt', () => {
  it('appends file path to template', () => {
    const result = buildPerFilePrompt('src/a.ts', 'Audit for correctness issues.');
    expect(result).toContain('Audit for correctness issues.');
    expect(result).toContain('Read and analyze this file:');
    expect(result).toContain('- src/a.ts');
  });
});


