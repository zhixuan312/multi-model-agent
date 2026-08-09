import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const planImpl = read('packages/core/src/skills/plan/implement.md');
const planRev = read('packages/core/src/skills/plan/review.md');
const execImpl = read('packages/core/src/skills/execute_plan/implement.md');
const execRev = read('packages/core/src/skills/execute_plan/review.md');
const reviewImpl = read('packages/core/src/skills/review/implement.md');
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
  });

  it('plan/implement.md is human-executable: phased, technical-AC-per-task, human completion bar', () => {
    // Phases are the build story (human comprehension), each with "what works at the end".
    expect(planImpl).toContain('## Phase N —');
    expect(planImpl.toLowerCase()).toContain('what works at the end');
    // Business AC -> technical AC translation, traced.
    expect(planImpl).toContain('Technical acceptance criteria');
    expect(planImpl).toContain('← AC');
    // The completion bar is human-executability, not just agent-executability.
    expect(planImpl.toLowerCase()).toContain('human-executable');
    expect(planImpl.toLowerCase()).toContain('competent engineer');
    // Human divide-and-conquer, not a hundred micro-tasks nor two epics.
    expect(planImpl.toLowerCase()).toContain('divide and conquer');
  });

  it('plan/implement.md specifies the required render format (## phases, multi-line **Files:**) and MMA execution', () => {
    // Phases parse by level-2 headings; task files by a multi-line `- ` bullet list.
    expect(planImpl.toLowerCase()).toContain('required heading & file conventions');
    expect(planImpl).toContain('## Phase N —');
    // The Files template must be the multi-line bullet form, not a single inline line.
    expect(planImpl).toMatch(/\*\*Files:\*\*\n- Create:/);
    expect(planImpl).toContain('- Test: `');
    // MMA executes its own plans: reference mma-execute-plan, never superpowers, and don't name Forge.
    expect(planImpl).toContain('mma-execute-plan');
    expect(planImpl.toLowerCase()).not.toContain('superpowers');
    expect(planImpl.toLowerCase()).not.toContain('forge');
  });

  it('plan/implement.md drops the verbatim-code / size-cap mandates', () => {
    expect(planImpl).not.toContain('show ALL the code');
    expect(planImpl).not.toMatch(/Maximum 6 steps/i);
    expect(planImpl).not.toMatch(/Maximum 3 source files/i);
  });

  it('plan/review.md checks phases, technical ACs, and contract completeness', () => {
    expect(planRev.toLowerCase()).toContain('human-executable phases');
    expect(planRev.toLowerCase()).toContain('technical acceptance criterion');
    expect(planRev.toLowerCase()).toContain('contract completeness');
    expect(planRev).toContain('contractCompleteness');
  });
});

describe('autonomous executor prompts (I-7)', () => {
  it('execute_plan/implement.md is the autonomous-executor mandate', () => {
    expect(execImpl.toLowerCase()).toContain('autonomous implementer');
    expect(execImpl).toContain('MUST NOT create, move, edit, overwrite, delete, weaken, or');
    // The pipeline materializes the tests before the worker runs; the worker implements
    // against them as-is and must never re-materialize them or treat their presence as a collision.
    expect(execImpl.toLowerCase()).toContain('already present in your workspace');
    expect(execImpl.toLowerCase()).toContain('never treat it as a collision');
    expect(execImpl).toContain('status: "failed"');
    expect(execImpl).toContain('Reconciliation');
  });

  it('execute_plan/implement.md contains no mechanical-copyist language', () => {
    expect(execImpl.toLowerCase()).not.toContain('mechanical executor');
    expect(execImpl.toLowerCase()).not.toContain('character-for-character');
    expect(execImpl).not.toContain('CODE SUBSTITUTION');
  });

  it('execute_plan/implement.md keeps the house-style headers but stays lean', () => {
    // House style: the standard section headers are kept so every skill reads consistently.
    for (const h of ['## Role', '## Task', '## Context', '## Constraints', '## Output']) {
      expect(execImpl).toContain(h);
    }
    // Agent-audience: the "how to work" babysitting is stripped, unlike the old mechanical version.
    expect(execImpl).not.toContain('Turn Budget');
    expect(execImpl.toLowerCase()).not.toContain('restart-loop');
    expect(execImpl.toLowerCase()).not.toContain('do not over-verify');
    // Well below the old ~77-line mechanical-executor prompt.
    expect(execImpl.split('\n').length).toBeLessThan(60);
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
  // Ratchet updated deliberately: this previously required the doc to state a
  // `completionPercent >= 80` commit gate. That gate is gone — execute_plan reports completion
  // rather than gating on it, because failing terminally on a judgement about the work is what
  // caused correct implementations to be abandoned. The doc must now say the opposite, and the
  // assertions below pin the REPLACEMENT contract so it cannot silently regress to a gate.
  it('mma-execute-plan/SKILL.md describes autonomous execution + error codes + advisory completion', () => {
    expect(mmaExecDoc.toLowerCase()).toContain('autonomous');
    for (const code of ['unsupported-legacy-plan', 'malformed-plan', 'unsafe-test-path', 'test-path-collision']) {
      expect(mmaExecDoc).toContain(code);
    }
    // Completion is reported, and reporting is per-task.
    expect(mmaExecDoc).toContain('completionPercent');
    expect(mmaExecDoc).toContain('done_with_concerns');
    // The doc must state that work lands even when there are concerns…
    expect(mmaExecDoc.toLowerCase()).toContain('committed on your branch');
    // …and must NOT reintroduce a numeric commit gate.
    expect(mmaExecDoc).not.toContain('>= 80');
  });
});

describe('generic implementers stay deliverable-neutral, software technique moved out (I-9)', () => {
  it('plan/implement.md and execute_plan/implement.md point at the software practice asset instead of repeating its technique', () => {
    expect(planImpl).toContain("practice: 'software'");
    expect(execImpl).toContain("practice: 'software'");
    // The technique itself — not just its name — lives only in implement-software.md.
    expect(planImpl).not.toContain('security sinks');
    expect(execImpl).not.toContain('security sinks');
  });

  it('review/implement.md is deliverable-neutral: generalized taxonomy, no source-code-only vocabulary', () => {
    expect(reviewImpl).toContain("practice: 'software'");
    for (const codeOnlyTerm of ['TOCTOU', 'N+1', 'the diff', 'wire schema']) {
      expect(reviewImpl).not.toContain(codeOnlyTerm);
    }
    expect(reviewImpl.toLowerCase()).toContain('deliverable-neutral');
  });

  it('every generic implementer that offers a software practice ships the matching implement-software.md', () => {
    for (const route of ['plan', 'execute_plan', 'review', 'debug']) {
      expect(() => read(`packages/core/src/skills/${route}/implement-software.md`)).not.toThrow();
    }
  });
});
