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

describe('validateSubAgentOutput with hasFileArtifacts', () => {
  it('workerStatus done + hasFileArtifacts → valid even with fragment-like output', () => {
    const result = validateSubAgentOutput('Here are the results:', {
      workerStatus: 'done',
      hasFileArtifacts: true,
    });
    expect(result.valid).toBe(true);
  });

  it('workerStatus done + hasFileArtifacts → valid even with short output', () => {
    const result = validateSubAgentOutput('ok', {
      workerStatus: 'done',
      hasFileArtifacts: true,
    });
    expect(result.valid).toBe(true);
  });

  it('workerStatus done_with_concerns + hasFileArtifacts → valid', () => {
    const result = validateSubAgentOutput('Done but check the edge case:', {
      workerStatus: 'done_with_concerns',
      hasFileArtifacts: true,
    });
    expect(result.valid).toBe(true);
  });

  it('hasFileArtifacts without workerStatus → falls through to heuristic', () => {
    const result = validateSubAgentOutput('let me check', {
      hasFileArtifacts: true,
    });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('fragment');
  });

  it('hasFileArtifacts does not override empty output', () => {
    const result = validateSubAgentOutput('', {
      workerStatus: 'done',
      hasFileArtifacts: true,
    });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('empty');
  });

  it('hasFileArtifacts does not override thinking_only', () => {
    const result = validateSubAgentOutput(
      '[model final message contained only <think>...</think> reasoning, no plain-text answer]',
      { workerStatus: 'done', hasFileArtifacts: true },
    );
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('thinking_only');
  });

  it('workerStatus blocked + hasFileArtifacts → falls through (not auto-validated)', () => {
    const result = validateSubAgentOutput('I am blocked on this task', {
      workerStatus: 'blocked',
      hasFileArtifacts: true,
    });
    expect(result.valid).toBe(true);
  });

  it('workerStatus needs_context + hasFileArtifacts → falls through', () => {
    const result = validateSubAgentOutput('I need more context', {
      workerStatus: 'needs_context',
      hasFileArtifacts: true,
    });
    expect(result.valid).toBe(true);
  });
});