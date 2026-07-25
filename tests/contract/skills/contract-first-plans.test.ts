import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const planImpl = read('packages/core/src/skills/plan/implement.md');
const planRev = read('packages/core/src/skills/plan/review.md');
const execImpl = read('packages/core/src/skills/execute_plan/implement.md');
const execRev = read('packages/core/src/skills/execute_plan/review.md');
const mmaPlanDoc = read('packages/server/src/skills/mma-plan/SKILL.md');
const mmaExecDoc = read('packages/server/src/skills/mma-execute-plan/SKILL.md');

describe('contract-first plan authoring prompts (I-6)', () => {
  it('plan/implement.md expresses the frozen Contract Task template', () => {
    for (const label of ['Inputs / Request:', 'Outputs / Response:', 'Data mapping:', 'Errors:', 'Behavior / invariants:']) {
      expect(planImpl).toContain(label);
    }
    expect(planImpl).toContain('Acceptance tests (plan-authored');
    expect(planImpl).toContain('Path:');
    expect(planImpl).toContain('Run:');
    expect(planImpl).toContain('**Implementation:** left to the executor');
    expect(planImpl.toLowerCase()).toContain('contract boundary');
  });

  it('plan/implement.md drops the verbatim-code / size-cap mandates', () => {
    expect(planImpl).not.toContain('show ALL the code');
    expect(planImpl).not.toMatch(/Maximum 6 steps/i);
    expect(planImpl).not.toMatch(/Maximum 3 source files/i);
  });

  it('plan/review.md checks contract completeness and emits optional contractCompleteness', () => {
    expect(planRev.toLowerCase()).toContain('contract completeness');
    expect(planRev).toContain('contractCompleteness');
    expect(planRev.toLowerCase()).not.toContain('verbatim-code fidelity enforced');
  });
});

describe('autonomous executor prompts (I-7)', () => {
  it('execute_plan/implement.md is the autonomous-executor mandate', () => {
    expect(execImpl.toLowerCase()).toContain('autonomous implementer');
    expect(execImpl).toContain('MUST NOT weaken, skip, delete, or replace');
    expect(execImpl).toContain('test-path-collision');
    expect(execImpl).toContain('status: "failed"');
    expect(execImpl).toContain('Reconciliation');
  });

  it('execute_plan/implement.md contains no mechanical-copyist language', () => {
    expect(execImpl.toLowerCase()).not.toContain('mechanical executor');
    expect(execImpl.toLowerCase()).not.toContain('character-for-character');
    expect(execImpl).not.toContain('CODE SUBSTITUTION');
  });

  it('execute_plan/review.md defines fidelity as contract satisfaction + passing tests, not verbatim', () => {
    expect(execRev.toLowerCase()).toContain('contract satisfied');
    expect(execRev.toLowerCase()).toContain('acceptance tests pass');
    expect(execRev.toLowerCase()).toContain('do not enforce verbatim');
    expect(execRev).not.toContain('CODE SUBSTITUTION');
    expect(execRev.toLowerCase()).not.toContain('were code blocks applied verbatim');
  });
});

describe('public skill docs describe contract-first (I-8)', () => {
  it('mma-plan/SKILL.md describes Contract Tasks + plan-authored acceptance tests', () => {
    expect(mmaPlanDoc).toContain('Contract Task');
    expect(mmaPlanDoc.toLowerCase()).toContain('plan-authored acceptance tests');
    expect(mmaPlanDoc.toLowerCase()).not.toContain('follow mechanically');
  });
  it('mma-execute-plan/SKILL.md describes autonomous execution + error codes + the 80 gate', () => {
    expect(mmaExecDoc.toLowerCase()).toContain('autonomous');
    for (const code of ['unsupported-legacy-plan', 'malformed-plan', 'unsafe-test-path', 'test-path-collision']) {
      expect(mmaExecDoc).toContain(code);
    }
    expect(mmaExecDoc).toContain('completionPercent >= 80');
  });
});
