import { describe, it, expect } from 'vitest';
import { taskInputSchema } from '../../packages/core/src/unified/task-input-schema.js';

describe('taskInputSchema', () => {
  it('accepts delegate with prompt', () => {
    expect(taskInputSchema.safeParse({
      type: 'delegate',
      prompt: 'do X',
    }).success).toBe(true);
  });

  it('accepts delegate with prompt + target + done', () => {
    expect(taskInputSchema.safeParse({
      type: 'delegate',
      prompt: 'Add validation',
      target: { paths: ['src/auth.ts'] },
      done: 'tests pass',
    }).success).toBe(true);
  });

  it('accepts audit with target.paths', () => {
    expect(taskInputSchema.safeParse({
      type: 'audit',
      target: { paths: ['/doc.md'] },
    }).success).toBe(true);
  });

  it('accepts audit with target.inline', () => {
    expect(taskInputSchema.safeParse({
      type: 'audit',
      target: { inline: 'some content' },
    }).success).toBe(true);
  });

  it('rejects audit without target', () => {
    expect(taskInputSchema.safeParse({ type: 'audit' }).success).toBe(false);
  });

  it('rejects audit with both paths and inline', () => {
    expect(taskInputSchema.safeParse({
      type: 'audit',
      target: { paths: ['/doc.md'], inline: 'text' },
    }).success).toBe(false);
  });

  it('rejects unknown type', () => {
    expect(taskInputSchema.safeParse({ type: 'bogus' }).success).toBe(false);
  });

  it('accepts common optional fields including agentTier', () => {
    const r = taskInputSchema.safeParse({
      type: 'delegate',
      prompt: 'do X',
      agentTier: 'complex',
      reviewPolicy: 'none',
      sessionIds: { implementer: 'sess-1' },
      contextBlockIds: ['blk-1'],
    });
    expect(r.success).toBe(true);
  });

  it('accepts up to 2 contextBlockIds', () => {
    expect(taskInputSchema.safeParse({
      type: 'delegate',
      prompt: 'do X',
      contextBlockIds: ['blk-1', 'blk-2'],
    }).success).toBe(true);
  });

  it('rejects more than 2 contextBlockIds', () => {
    expect(taskInputSchema.safeParse({
      type: 'delegate',
      prompt: 'do X',
      contextBlockIds: ['blk-1', 'blk-2', 'blk-3'],
    }).success).toBe(false);
  });

  it('rejects legacy reviewPolicy values', () => {
    expect(taskInputSchema.safeParse({
      type: 'delegate',
      prompt: 'x',
      reviewPolicy: 'full',
    }).success).toBe(false);
  });

  it('accepts investigate with prompt + target.paths', () => {
    expect(taskInputSchema.safeParse({
      type: 'investigate',
      prompt: 'How does auth work?',
      target: { paths: ['src/auth.ts'] },
    }).success).toBe(true);
  });

  it('accepts investigate with prompt only (no target)', () => {
    expect(taskInputSchema.safeParse({
      type: 'investigate',
      prompt: 'How does auth work?',
    }).success).toBe(true);
  });

  it('rejects investigate with deprecated question field', () => {
    expect(taskInputSchema.safeParse({
      type: 'investigate',
      question: 'How does auth work?',
    }).success).toBe(false);
  });

  it('accepts execute_plan with target.paths + tasks', () => {
    expect(taskInputSchema.safeParse({
      type: 'execute_plan',
      target: { paths: ['/plan.md'] },
      tasks: ['Task 1'],
    }).success).toBe(true);
  });

  it('accepts execute_plan with empty tasks (run all)', () => {
    expect(taskInputSchema.safeParse({
      type: 'execute_plan',
      target: { paths: ['/plan.md'] },
    }).success).toBe(true);
  });

  it('rejects execute_plan with multiple paths', () => {
    expect(taskInputSchema.safeParse({
      type: 'execute_plan',
      target: { paths: ['/a.md', '/b.md'] },
    }).success).toBe(false);
  });

  it('rejects execute_plan with deprecated taskDescriptors', () => {
    expect(taskInputSchema.safeParse({
      type: 'execute_plan',
      filePaths: ['/plan.md'],
      taskDescriptors: ['Task 1'],
    }).success).toBe(false);
  });

  it('accepts research with prompt', () => {
    expect(taskInputSchema.safeParse({
      type: 'research',
      prompt: 'What are the best practices for X in the industry?',
    }).success).toBe(true);
  });

  it('rejects research with deprecated researchQuestion', () => {
    expect(taskInputSchema.safeParse({
      type: 'research',
      researchQuestion: 'What?',
      background: 'Some context for the question here.',
    }).success).toBe(false);
  });

  it('accepts journal_recall with prompt', () => {
    expect(taskInputSchema.safeParse({
      type: 'journal_recall',
      prompt: 'What did we learn about caching?',
    }).success).toBe(true);
  });

  it('rejects journal_recall with deprecated query', () => {
    expect(taskInputSchema.safeParse({
      type: 'journal_recall',
      query: 'caching?',
    }).success).toBe(false);
  });

  it('accepts journal_record with prompt', () => {
    expect(taskInputSchema.safeParse({
      type: 'journal_record',
      prompt: 'We decided to use Redis for caching because...',
    }).success).toBe(true);
  });

  it('rejects journal_record with deprecated entry', () => {
    expect(taskInputSchema.safeParse({
      type: 'journal_record',
      entry: 'learning',
    }).success).toBe(false);
  });

  it('accepts review with target.paths', () => {
    expect(taskInputSchema.safeParse({
      type: 'review',
      target: { paths: ['/src/main.ts'] },
    }).success).toBe(true);
  });

  it('accepts review with target.inline', () => {
    expect(taskInputSchema.safeParse({
      type: 'review',
      target: { inline: 'const x = 1;' },
    }).success).toBe(true);
  });

  it('rejects review with deprecated code field', () => {
    expect(taskInputSchema.safeParse({
      type: 'review',
      code: 'const x = 1;',
    }).success).toBe(false);
  });

  it('accepts debug with prompt + target.paths', () => {
    expect(taskInputSchema.safeParse({
      type: 'debug',
      prompt: 'TypeError: cannot read property',
      target: { paths: ['src/auth.ts'] },
    }).success).toBe(true);
  });

  it('accepts debug with prompt only (no target)', () => {
    expect(taskInputSchema.safeParse({
      type: 'debug',
      prompt: 'TypeError: cannot read property verify of undefined',
    }).success).toBe(true);
  });

  it('rejects debug with deprecated errorMessage', () => {
    expect(taskInputSchema.safeParse({
      type: 'debug',
      errorMessage: 'TypeError',
    }).success).toBe(false);
  });

  it('accepts retry_tasks with taskId and taskIndices', () => {
    expect(taskInputSchema.safeParse({
      type: 'retry_tasks',
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      taskIndices: [0, 1],
    }).success).toBe(true);
  });

  it('rejects retry_tasks with empty taskIndices', () => {
    expect(taskInputSchema.safeParse({
      type: 'retry_tasks',
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      taskIndices: [],
    }).success).toBe(false);
  });

  it('rejects retry_tasks with non-uuid taskId', () => {
    expect(taskInputSchema.safeParse({
      type: 'retry_tasks',
      taskId: 'not-a-uuid',
      taskIndices: [0],
    }).success).toBe(false);
  });

  it('accepts orchestrate with prompt', () => {
    expect(taskInputSchema.safeParse({
      type: 'orchestrate',
      prompt: 'Synthesize the exploration results into a specification.',
    }).success).toBe(true);
  });

  it('accepts orchestrate with prompt and outputFormat', () => {
    const r = taskInputSchema.safeParse({
      type: 'orchestrate',
      prompt: 'List all API endpoints.',
      outputFormat: 'json',
    });
    expect(r.success).toBe(true);
  });

  it('rejects orchestrate with empty prompt', () => {
    expect(taskInputSchema.safeParse({
      type: 'orchestrate',
      prompt: '',
    }).success).toBe(false);
  });

  // ── spec task type ──

  it('accepts spec with prompt + target.inline', () => {
    expect(taskInputSchema.safeParse({
      type: 'spec',
      prompt: 'Input validation for math module',
      target: { inline: '## Context\ntest' },
    }).success).toBe(true);
  });

  it('accepts spec with prompt + target.paths', () => {
    expect(taskInputSchema.safeParse({
      type: 'spec',
      prompt: 'Input validation for math module',
      target: { paths: ['/project/design-decisions.md'] },
    }).success).toBe(true);
  });

  it('accepts spec with optional outputPath', () => {
    expect(taskInputSchema.safeParse({
      type: 'spec',
      prompt: 'Input validation for math module',
      target: { inline: '## Context\ntest' },
      outputPath: 'docs/mma/specs/2026-07-06-input-validation.md',
    }).success).toBe(true);
  });

  it('rejects spec without prompt', () => {
    expect(taskInputSchema.safeParse({
      type: 'spec',
      target: { inline: 'content' },
    }).success).toBe(false);
  });

  it('rejects spec without target', () => {
    expect(taskInputSchema.safeParse({
      type: 'spec',
      prompt: 'test',
    }).success).toBe(false);
  });

  it('rejects spec with both paths and inline', () => {
    expect(taskInputSchema.safeParse({
      type: 'spec',
      prompt: 'test',
      target: { paths: ['/doc.md'], inline: 'text' },
    }).success).toBe(false);
  });

  // ── plan task type ──

  it('accepts plan with prompt + target.paths', () => {
    expect(taskInputSchema.safeParse({
      type: 'plan',
      prompt: 'Write a TDD plan for this spec',
      target: { paths: ['/project/docs/spec.md'] },
    }).success).toBe(true);
  });

  it('accepts plan with prompt + target.inline + outputPath', () => {
    expect(taskInputSchema.safeParse({
      type: 'plan',
      prompt: 'Write a TDD plan',
      target: { inline: '# Spec content...' },
      outputPath: 'docs/mma/plans/2026-07-06-feature.md',
    }).success).toBe(true);
  });

  it('accepts plan with optional outputPath', () => {
    expect(taskInputSchema.safeParse({
      type: 'plan',
      prompt: 'Write a TDD plan',
      target: { paths: ['/spec.md'] },
      outputPath: 'docs/mma/plans/custom.md',
    }).success).toBe(true);
  });

  it('rejects plan without prompt', () => {
    expect(taskInputSchema.safeParse({
      type: 'plan',
      target: { paths: ['/spec.md'] },
    }).success).toBe(false);
  });

  it('rejects plan without target', () => {
    expect(taskInputSchema.safeParse({
      type: 'plan',
      prompt: 'test',
    }).success).toBe(false);
  });

  it('rejects plan with both paths and inline', () => {
    expect(taskInputSchema.safeParse({
      type: 'plan',
      prompt: 'test',
      target: { paths: ['/doc.md'], inline: 'text' },
    }).success).toBe(false);
  });
});
