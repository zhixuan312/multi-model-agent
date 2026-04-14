import { describe, it, expect } from 'vitest';
import { validateSubAgentOutput, hasCompletedWork, extractToolName } from '../packages/core/src/runners/supervision.js';

describe('supervision with completed work', () => {
  it('skips fragment/no_terminator when skipCompletionHeuristic is true', () => {
    const result = validateSubAgentOutput('Here are the results:', {
      skipCompletionHeuristic: true,
    });
    expect(result.valid).toBe(true);
  });

  it('still catches empty output even with skipCompletionHeuristic', () => {
    const result = validateSubAgentOutput('', {
      skipCompletionHeuristic: true,
    });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('empty');
  });

  it('still catches thinking-only even with skipCompletionHeuristic', () => {
    const result = validateSubAgentOutput(
      '[model final message contained only <think>...</think> reasoning, no plain-text answer]',
      { skipCompletionHeuristic: true },
    );
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('thinking_only');
  });
});

describe('hasCompletedWork', () => {
  it('returns true for writeFile calls', () => {
    expect(hasCompletedWork(['readFile(src/foo.ts)', 'writeFile(src/bar.ts, 100B)'])).toBe(true);
  });

  it('returns true for editFile calls', () => {
    expect(hasCompletedWork(['readFile(src/foo.ts)', 'editFile(src/bar.ts, 50B->60B)'])).toBe(true);
  });

  it('returns false for read-only calls', () => {
    expect(hasCompletedWork(['readFile(src/foo.ts)', 'grep(pattern, .)', 'glob(*.ts)'])).toBe(false);
  });

  it('returns false for empty tool calls', () => {
    expect(hasCompletedWork([])).toBe(false);
  });
});

describe('extractToolName', () => {
  it('extracts name before parenthesis', () => {
    expect(extractToolName('writeFile(src/foo.ts, 100B)')).toBe('writeFile');
  });

  it('returns full string if no parenthesis', () => {
    expect(extractToolName('someFunction')).toBe('someFunction');
  });
});