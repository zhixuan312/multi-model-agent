import { describe, it, expect } from 'vitest';
import { taskInputSchema } from '../../packages/core/src/unified/task-input-schema.js';

describe('taskInputSchema', () => {
  it('accepts spec with a non-empty canonical components subset', () => {
    expect(taskInputSchema.safeParse({
      type: 'spec',
      prompt: 'Subset spec request',
      target: { inline: '## Context\n\n### Background\ntext' },
      components: ['Technical Design', 'Context'],
    }).success).toBe(true);
  });

  it('accepts spec with an empty components array', () => {
    expect(taskInputSchema.safeParse({
      type: 'spec',
      prompt: 'Empty subset means default',
      target: { inline: '## Context\n\n### Background\ntext' },
      components: [],
    }).success).toBe(true);
  });

  it('rejects spec with an unknown component label', () => {
    expect(taskInputSchema.safeParse({
      type: 'spec',
      prompt: 'Bad subset request',
      target: { inline: '## Context\n\n### Background\ntext' },
      components: ['Context', 'Decision Records'],
    }).success).toBe(false);
  });

  it('accepts duplicate canonical labels so the resolver can deduplicate them later', () => {
    expect(taskInputSchema.safeParse({
      type: 'spec',
      prompt: 'Duplicate subset request',
      target: { inline: '## Context\n\n### Background\ntext' },
      components: ['Context', 'Context', 'Problem'],
    }).success).toBe(true);
  });
});
