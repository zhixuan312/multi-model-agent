import {
  buildSystemPrompt,
  buildBudgetHint,
  buildReGroundingMessage,
  buildBudgetPressureNudge,
  buildFormatConstraintSuffix,
  RE_GROUNDING_INTERVAL_TURNS,
} from '../../packages/core/src/runners/prevention.js';

describe('buildSystemPrompt', () => {
  it('produces a non-empty prompt', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.length).toBeGreaterThan(500);
  });

  it('mentions the "final assistant message" rule', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('final assistant message');
  });

  it('mentions the anti-pattern about "let me check X next"', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain('let me check');
  });

  it('mentions the anti-pattern about <think> content', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('<think>');
  });

  it('steers workers toward edit_file for partial modifications', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('edit_file');
  });

  it('steers write_file for new files only', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('write_file');
    expect(prompt).toContain('edit_file to modify');
  });

  it('steers file modifications to tracked tools, not shell', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('edit_file or write_file for all file modifications');
    expect(prompt).toContain('sed, awk');
  });

  it('requires enough surrounding context for unique edit match', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('exactly one location');
    expect(prompt).toContain('surrounding context');
  });

  it('is deterministic — two calls produce byte-identical output', () => {
    const a = buildSystemPrompt();
    const b = buildSystemPrompt();
    expect(a).toBe(b);
  });

  it('includes shell usage guidance for run_shell', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('run_shell');
  });

  it('recommends targeted tests over full suites', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('targeted tests');
  });

  it('restricts package installation and destructive commands to explicit requests', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Only install packages');
    expect(prompt).toContain('explicitly requests it');
  });
});

describe('buildBudgetHint', () => {
  it('mentions the maxTurns value', () => {
    const hint = buildBudgetHint({ maxTurns: 200 });
    expect(hint).toContain('200');
  });

  it('mentions the half-budget checkpoint', () => {
    const hint = buildBudgetHint({ maxTurns: 200 });
    expect(hint).toContain('100');
  });

  it('is deterministic for the same maxTurns', () => {
    const a = buildBudgetHint({ maxTurns: 50 });
    const b = buildBudgetHint({ maxTurns: 50 });
    expect(a).toBe(b);
  });
});

describe('buildReGroundingMessage', () => {
  it('includes the original prompt excerpt truncated to 200 chars', () => {
    const longPrompt = 'a'.repeat(300);
    const msg = buildReGroundingMessage({
      originalPromptExcerpt: longPrompt,
      currentTurn: 10,
      maxTurns: 200,
      toolCallsSoFar: 5,
      filesReadSoFar: 3,
    });
    expect(msg).toContain('a'.repeat(200));
    expect(msg).toContain('...');
  });

  it('includes the percentage of budget used', () => {
    const msg = buildReGroundingMessage({
      originalPromptExcerpt: 'short',
      currentTurn: 50,
      maxTurns: 200,
      toolCallsSoFar: 0,
      filesReadSoFar: 0,
    });
    expect(msg).toContain('25%');
  });

  it('is deterministic for the same inputs', () => {
    const args = {
      originalPromptExcerpt: 'audit fate',
      currentTurn: 10,
      maxTurns: 200,
      toolCallsSoFar: 5,
      filesReadSoFar: 3,
    };
    const a = buildReGroundingMessage(args);
    const b = buildReGroundingMessage(args);
    expect(a).toBe(b);
  });
});

describe('RE_GROUNDING_INTERVAL_TURNS', () => {
  it('is 10', () => {
    expect(RE_GROUNDING_INTERVAL_TURNS).toBe(10);
  });
});

describe('buildBudgetPressureNudge', () => {
  it('mentions both the current input tokens and the soft limit', () => {
    const msg = buildBudgetPressureNudge({ inputTokens: 850_000, softLimit: 1_000_000 });
    expect(msg).toContain('850000');
    expect(msg).toContain('1000000');
  });

  it('tells the model to produce a final answer', () => {
    const msg = buildBudgetPressureNudge({ inputTokens: 100, softLimit: 200 });
    expect(msg.toLowerCase()).toContain('produce your complete final answer');
  });

  it('is deterministic for the same inputs', () => {
    const args = { inputTokens: 12345, softLimit: 20000 };
    const a = buildBudgetPressureNudge(args);
    const b = buildBudgetPressureNudge(args);
    expect(a).toBe(b);
  });
});

describe('buildFormatConstraintSuffix (1.0.0)', () => {
  it('returns empty string when no constraints', () => {
    const s = buildFormatConstraintSuffix({});
    expect(s).toBe('');
  });

  it('adds input format when specified', () => {
    const s = buildFormatConstraintSuffix({ inputFormat: 'json' });
    expect(s).toContain('input format: json');
  });

  it('adds output format when specified', () => {
    const s = buildFormatConstraintSuffix({ outputFormat: 'yaml' });
    expect(s).toContain('output format: yaml');
  });

  it('combines both when both specified', () => {
    const s = buildFormatConstraintSuffix({ inputFormat: 'json', outputFormat: 'yaml' });
    expect(s).toContain('input format: json');
    expect(s).toContain('output format: yaml');
  });
});
