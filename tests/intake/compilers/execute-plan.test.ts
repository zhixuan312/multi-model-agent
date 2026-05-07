import { describe, it, expect } from 'vitest';
import { compileExecutePlan } from '../../../packages/core/src/intake/brief-compiler-slots/execute-plan.js';

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

  it('prompt instructs worker to follow plan exactly', () => {
    const drafts = compileExecutePlan(
      { tasks: ['Task 1: Add widget'], fileContents: '# Plan\n## Task 1: Add widget\nCreate widget.ts', filePaths: ['plan.md'] },
      'req-1',
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].prompt).toContain('Follow the plan exactly as written');
    expect(drafts[0].prompt).toContain('Do not redesign');
    expect(drafts[0].prompt).toContain('use them verbatim');
  });

  it('compiled execute-plan prompt contains scope-contract clause verbatim', () => {
    const drafts = compileExecutePlan(
      { tasks: ['1. do X\n2. do Y'], fileContents: '# Plan\n1. do X\n2. do Y' },
      'req',
    );
    expect(drafts[0].prompt).toContain('Execute exactly the steps in the plan');
    expect(drafts[0].prompt).toContain('Do NOT add steps not in the plan');
  });
});
