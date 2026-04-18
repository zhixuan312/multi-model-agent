import { describe, it, expect } from 'vitest';
import { compileExecutePlan } from '../../../packages/core/src/intake/compilers/execute-plan.js';

describe('execute-plan compiler', () => {
  const planContent = `# Implementation Plan

### Task 1: Setup database schema

Create the schema file at db/schema.sql with users and posts tables.

### Task 2: Build API endpoints

Create REST endpoints for CRUD operations on users.
`;

  it('creates one draft per task entry', () => {
    const drafts = compileExecutePlan({
      tasks: ['1. Setup database schema', '2. Build API endpoints'],
      fileContents: planContent,
    }, 'req');
    expect(drafts).toHaveLength(2);
  });

  it('sets route to execute_plan on each draft source', () => {
    const drafts = compileExecutePlan({
      tasks: ['1. Setup database schema'],
      fileContents: planContent,
    }, 'req');
    expect(drafts[0].source.route).toBe('execute_plan');
  });

  it('includes plan content in prompt', () => {
    const drafts = compileExecutePlan({
      tasks: ['1. Setup database schema'],
      fileContents: planContent,
    }, 'req');
    expect(drafts[0].prompt).toContain('Implementation Plan');
    expect(drafts[0].prompt).toContain('Setup database schema');
  });

  it('includes task descriptor in prompt', () => {
    const drafts = compileExecutePlan({
      tasks: ['1. Setup database schema'],
      fileContents: planContent,
    }, 'req');
    expect(drafts[0].prompt).toContain('Requested task: "1. Setup database schema"');
  });

  it('includes execution instruction in prompt', () => {
    const drafts = compileExecutePlan({
      tasks: ['1. Setup database schema'],
      fileContents: planContent,
    }, 'req');
    expect(drafts[0].prompt).toContain('Find this task in the plan/spec documents above');
    expect(drafts[0].prompt).toContain('If you cannot find a unique matching task');
  });

  it('stores single task descriptor in source.task', () => {
    const drafts = compileExecutePlan({
      tasks: ['1. Setup database schema', '2. Build API endpoints'],
      fileContents: planContent,
    }, 'req');
    expect((drafts[0].source as any).task).toBe('1. Setup database schema');
    expect((drafts[1].source as any).task).toBe('2. Build API endpoints');
  });

  it('assigns unique draft IDs per task', () => {
    const drafts = compileExecutePlan({
      tasks: ['1. Setup database schema', '2. Build API endpoints'],
      fileContents: planContent,
    }, 'req');
    expect(drafts[0].draftId).not.toBe(drafts[1].draftId);
  });

  it('stores filePaths in source', () => {
    const drafts = compileExecutePlan({
      tasks: ['1. Setup database schema'],
      fileContents: planContent,
      filePaths: ['plan.md', 'spec.md'],
    }, 'req');
    expect((drafts[0].source as any).filePaths).toEqual(['plan.md', 'spec.md']);
  });
});
