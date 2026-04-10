import {
  validateCompletion,
  buildRePrompt,
  sameDegenerateOutput,
} from '../../packages/core/src/runners/supervision.js';

describe('validateCompletion — empty detection', () => {
  it('detects an empty string', () => {
    const result = validateCompletion('');
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('empty');
  });

  it('detects whitespace-only as empty', () => {
    const result = validateCompletion('   \n\t  ');
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('empty');
  });
});

describe('validateCompletion — thinking-only detection', () => {
  it('detects when stripThinkingTags would reduce to the diagnostic marker', () => {
    const input = '[model final message contained only <think>...</think> reasoning, no plain-text answer]';
    const result = validateCompletion(input);
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('thinking_only');
  });
});

describe('validateCompletion — fragment ending detection', () => {
  it('detects "let me check" continuation phrase', () => {
    const result = validateCompletion('Now let me check the SSE hook and BottomNav:');
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('fragment');
    expect(result.tail).toContain('let me check');
  });

  it('detects bare colon ending', () => {
    const result = validateCompletion('Here is what I found:');
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('fragment');
  });

  it('detects "i\'ll continue" phrase', () => {
    const result = validateCompletion("I'll continue exploring the codebase");
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('fragment');
  });

  it('does NOT trigger on a long valid response that happens to contain "let me"', () => {
    const longText = 'This is a complete answer. Let me also note that everything is working. ' +
      'There are no further issues. The system has been thoroughly verified across all '.repeat(5);
    const result = validateCompletion(longText);
    expect(result.valid).toBe(true);
  });
});

describe('validateCompletion — no terminator detection', () => {
  it('detects short text with no terminal punctuation and no markdown', () => {
    const result = validateCompletion('this is some text without a proper end');
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('no_terminator');
  });

  it('does NOT trigger on short text with terminal period', () => {
    const result = validateCompletion('this is short but complete.');
    expect(result.valid).toBe(true);
  });

  it('does NOT trigger on short text with markdown header', () => {
    const result = validateCompletion('# Heading\n\nSome content');
    expect(result.valid).toBe(true);
  });

  it('does NOT trigger on short text with code fence', () => {
    const result = validateCompletion('Here:\n```\ncode\n```');
    expect(result.valid).toBe(true);
  });
});

describe('buildRePrompt — empty', () => {
  it('produces a re-prompt that mentions the empty response', () => {
    const result = validateCompletion('');
    const prompt = buildRePrompt(result);
    expect(prompt).toContain('previous response was empty');
    expect(prompt).toContain('plain text');
  });
});

describe('buildRePrompt — thinking_only', () => {
  it('produces a re-prompt that mentions the <think> tags', () => {
    const result = validateCompletion('[model final message contained only <think>...</think> reasoning, no plain-text answer]');
    const prompt = buildRePrompt(result);
    expect(prompt).toContain('<think>');
    expect(prompt).toContain('plain text');
  });
});

describe('buildRePrompt — fragment', () => {
  it('quotes the actual fragment tail back at the model', () => {
    const result = validateCompletion('Now let me check the SSE hook and BottomNav:');
    const prompt = buildRePrompt(result);
    expect(prompt).toContain('exploration fragment');
    expect(prompt).toContain('let me check the SSE hook and BottomNav:');
  });
});

describe('buildRePrompt — no_terminator', () => {
  it('produces a re-prompt that nudges toward a complete answer', () => {
    const result = validateCompletion('this is some text without a proper end');
    const prompt = buildRePrompt(result);
    expect(prompt).toContain('mid-thought');
  });
});

describe('sameDegenerateOutput', () => {
  it('returns true for byte-identical outputs', () => {
    expect(sameDegenerateOutput('foo', 'foo')).toBe(true);
  });

  it('returns false for different outputs', () => {
    expect(sameDegenerateOutput('foo', 'bar')).toBe(false);
  });

  it('returns false when only one is empty', () => {
    expect(sameDegenerateOutput('foo', '')).toBe(false);
  });

  it('returns true for two empty strings (identical garbage twice)', () => {
    expect(sameDegenerateOutput('', '')).toBe(true);
  });

  it('returns true for two whitespace-only strings (same after trim)', () => {
    expect(sameDegenerateOutput('   ', '\t')).toBe(true);
  });
});
