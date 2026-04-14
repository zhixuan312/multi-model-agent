import { describe, it, expect } from 'vitest';
import { inferEffort } from '../packages/core/src/effort-inference.js';

describe('inferEffort', () => {
  it('infers low for prompt with >20-line code block', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `  line ${i};`);
    const prompt = `Write this file:\n\`\`\`typescript\n${lines.join('\n')}\n\`\`\``;
    expect(inferEffort(prompt)).toBe('low');
  });

  it('does not infer low for code block with <=20 lines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `  line ${i};`);
    const prompt = `Write:\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
    expect(inferEffort(prompt)).not.toBe('low');
  });

  it('correctly subtracts fence lines from code block count', () => {
    // 22 lines between fences = exactly 20 + opening + closing = 22 total block lines
    // After subtracting 2 fence lines: 20 lines → not > 20 → should NOT be low
    const lines = Array.from({ length: 20 }, (_, i) => `  line ${i};`);
    const prompt = `\`\`\`\n${lines.join('\n')}\n\`\`\``;
    expect(inferEffort(prompt)).not.toBe('low');

    // 23 lines between fences = 21 + 2 fence lines → after subtracting: 21 > 20 → low
    const lines21 = Array.from({ length: 21 }, (_, i) => `  line ${i};`);
    const prompt21 = `\`\`\`\n${lines21.join('\n')}\n\`\`\``;
    expect(inferEffort(prompt21)).toBe('low');
  });

  it('infers medium for prompt referencing file edits', () => {
    const prompt = 'Edit the file src/tools/definitions.ts to fix the bug in writeFile.';
    expect(inferEffort(prompt)).toBe('medium');
  });

  it('infers medium for various action verbs with file paths', () => {
    expect(inferEffort('Modify src/types.ts to add the new field')).toBe('medium');
    expect(inferEffort('Update packages/core/src/runner.js with the fix')).toBe('medium');
    expect(inferEffort('Refactor lib/utils.py to use the new pattern')).toBe('medium');
  });

  it('returns undefined for generic prompt without file refs or code', () => {
    expect(inferEffort('What is the meaning of life?')).toBeUndefined();
  });

  it('returns undefined for file reference without action verb', () => {
    expect(inferEffort('Read src/types.ts and summarize the exports')).toBeUndefined();
  });

  it('returns undefined for action verb without file reference', () => {
    expect(inferEffort('Fix the authentication system')).toBeUndefined();
  });

  it('prefers low (code block) over medium (file reference)', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `  line ${i};`);
    const prompt = `Edit src/foo.ts with this content:\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
    expect(inferEffort(prompt)).toBe('low');
  });

});
