import { describe, it, expect } from 'vitest';
import { taskInputSchema } from '../../packages/core/src/unified/task-input-schema.js';

describe('taskInputSchema', () => {
  it('accepts delegate with tasks', () => {
    expect(taskInputSchema.safeParse({
      type: 'delegate',
      tasks: [{ prompt: 'do X' }],
    }).success).toBe(true);
  });

  it('accepts audit with filePaths', () => {
    expect(taskInputSchema.safeParse({
      type: 'audit',
      filePaths: ['/doc.md'],
    }).success).toBe(true);
  });

  it('accepts audit with document', () => {
    expect(taskInputSchema.safeParse({
      type: 'audit',
      document: 'some content',
    }).success).toBe(true);
  });

  it('rejects audit without document or filePaths', () => {
    expect(taskInputSchema.safeParse({ type: 'audit' }).success).toBe(false);
  });

  it('rejects unknown type', () => {
    expect(taskInputSchema.safeParse({ type: 'bogus' }).success).toBe(false);
  });

  it('accepts common optional fields', () => {
    const r = taskInputSchema.safeParse({
      type: 'delegate',
      tasks: [{ prompt: 'x' }],
      agentTier: 'complex',
      reviewPolicy: 'none',
      sessionIds: { implementer: 'sess-1' },
      contextBlockIds: ['blk-1'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects legacy reviewPolicy values', () => {
    expect(taskInputSchema.safeParse({
      type: 'delegate',
      tasks: [{ prompt: 'x' }],
      reviewPolicy: 'full',
    }).success).toBe(false);
  });

  it('accepts investigate with question', () => {
    expect(taskInputSchema.safeParse({
      type: 'investigate',
      question: 'How does auth work?',
    }).success).toBe(true);
  });

  it('accepts execute_plan', () => {
    expect(taskInputSchema.safeParse({
      type: 'execute_plan',
      filePaths: ['/plan.md'],
      taskDescriptors: ['Task 1'],
    }).success).toBe(true);
  });

  it('accepts research', () => {
    expect(taskInputSchema.safeParse({
      type: 'research',
      researchQuestion: 'What are the best practices for X in the industry?',
      background: 'We are building a system that does Y and need to understand Z.',
    }).success).toBe(true);
  });

  it('accepts journal_recall', () => {
    expect(taskInputSchema.safeParse({
      type: 'journal_recall',
      query: 'What did we learn about caching?',
    }).success).toBe(true);
  });

  it('accepts journal_record', () => {
    expect(taskInputSchema.safeParse({
      type: 'journal_record',
      entry: 'We decided to use Redis for caching because...',
    }).success).toBe(true);
  });

  it('accepts review', () => {
    expect(taskInputSchema.safeParse({
      type: 'review',
      filePaths: ['/src/main.ts'],
    }).success).toBe(true);
  });

  it('accepts debug', () => {
    expect(taskInputSchema.safeParse({
      type: 'debug',
      errorMessage: 'TypeError: cannot read property',
    }).success).toBe(true);
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
});
