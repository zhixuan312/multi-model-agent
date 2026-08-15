import { describe, it, expect } from 'vitest';
import {
  ACCEPTED_CHECK_ROOTS,
  CONTRACT_BULLET_LABELS,
  OUTPUT_FIELD_LABEL,
  DEPENDENCIES_FIELD_LABEL,
  CHECKS_HEADING_MARKER,
  PLAN_BOUNDARY_SENTINEL,
} from '../../../packages/core/src/unified/contract-plan.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// SPEC-005 Task I-6: assembled at runtime rather than written as one literal filename — this
// file is itself named in the practice-removal-sweep's `scopedFiles` list, so it must never
// carry the exact legacy filename it is checking is gone.
const LEGACY_ASSET_NAME = 'implement-' + 'software.md';

const planImpl = read('packages/core/src/skills/plan/implement.md');
const planRev = read('packages/core/src/skills/plan/review.md');
const execImpl = read('packages/core/src/skills/execute_plan/implement.md');
const execRev = read('packages/core/src/skills/execute_plan/review.md');
const reviewImpl = read('packages/core/src/skills/review/implement.md');
const mmaPlanDoc = read('packages/server/src/skills/mma-plan/SKILL.md');
const mmaExecDoc = read('packages/server/src/skills/mma-execute-plan/SKILL.md');

describe('contract-first plan authoring prompts (I-6)', () => {
  it('plan/implement.md expresses the deliverable-neutral Contract Task template', () => {
    for (const label of ['Inputs / Request:', 'Outputs / Response:', 'Data mapping:', 'Errors:', 'Behavior / invariants:']) {
      expect(planImpl).toContain(label);
    }
    expect(planImpl).toContain('**Output:**');
    expect(planImpl).toContain('**Dependencies:**');
    expect(planImpl).toContain('Checks (plan-authored');
    expect(planImpl).toContain('Check:');
    expect(planImpl).toContain('Run:');
    expect(planImpl).toContain('**Plan boundary:** final deliverable content is not in this plan.');
    // The retired software-only grammar must be gone from the generator prose, not merely renamed.
    expect(planImpl).not.toContain('**Files:**');
    expect(planImpl).not.toContain('Acceptance tests (plan-authored');
    expect(planImpl).not.toContain('**Implementation:** left to the executor');
  });

  it('plan/implement.md makes the declared-check section optional, not mandatory', () => {
    expect(planImpl.toLowerCase()).toContain('optional');
    // A task with no deterministic check is explicitly not an error.
    expect(planImpl.toLowerCase()).toContain('no deterministic check');
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

  it('plan/implement.md specifies the required render format (## phases, **Output:**/**Dependencies:**) and MMA execution', () => {
    // Phases parse by level-2 headings; task output/dependency metadata by two single lines.
    expect(planImpl.toLowerCase()).toContain('required heading & file conventions');
    expect(planImpl).toContain('## Phase N —');
    // The Output/Dependencies template must be two single lines, not a Files bullet list.
    expect(planImpl).toMatch(/\*\*Output:\*\* `/);
    expect(planImpl).toContain('**Dependencies:**');
    expect(planImpl).toContain('- Check: `');
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

  it('plan/review.md speaks the same deliverable-neutral grammar as the generator, not the retired one', () => {
    // The format literals themselves are asserted against the VALIDATOR's exported constants in
    // the "one vocabulary" block below, not restated here — restating them is what let the prompt
    // and the parser drift while this file stayed green.
    // A declared check is optional — the refiner must never fabricate one for an uncheckable task.
    expect(planRev.toLowerCase()).toContain('optional');
    expect(planRev).not.toContain('**Files:**');
    expect(planRev).not.toContain('Acceptance tests (plan-authored');
    expect(planRev).not.toContain('**Implementation:** left to the executor');
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
  it('mma-plan/SKILL.md describes Contract Tasks + plan-authored (optional) checks', () => {
    expect(mmaPlanDoc).toContain('Contract Task');
    expect(mmaPlanDoc.toLowerCase()).toContain('plan-authored');
    expect(mmaPlanDoc.toLowerCase()).toContain('deterministic check');
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

describe('generic implementers stay deliverable-neutral, software technique migrated to Method guidance (SPEC-005 Task I-6)', () => {
  it('plan/implement.md and execute_plan/implement.md point at Method guidance instead of repeating its technique', () => {
    expect(planImpl).toContain('committed guidance is injected as an additional block');
    expect(execImpl).toContain('committed guidance is injected as an additional block');
    // The technique itself — not just a pointer to it — lives only in the committed
    // software-change Method guidance now.
    expect(planImpl).not.toContain('security sinks');
    expect(execImpl).not.toContain('security sinks');
  });

  it('review/implement.md is deliverable-neutral: generalized taxonomy, no source-code-only vocabulary', () => {
    expect(reviewImpl).toContain('committed guidance is injected as an additional block');
    for (const codeOnlyTerm of ['TOCTOU', 'N+1', 'the diff', 'wire schema']) {
      expect(reviewImpl).not.toContain(codeOnlyTerm);
    }
    expect(reviewImpl.toLowerCase()).toContain('deliverable-neutral');
  });

  it('none of the four legacy code-technique assets ship any more — committed Method guidance replaces them', () => {
    for (const route of ['plan', 'execute_plan', 'review', 'debug']) {
      expect(() => read(`packages/core/src/skills/${route}/${LEGACY_ASSET_NAME}`)).toThrow();
    }
    expect(read('packages/core/src/methods/software-change/guidance.md')).toContain('Caller tracing');
  });
});

/**
 * The authoring prompts must speak the vocabulary the VALIDATOR parses.
 *
 * `skills/plan/{implement,review}.md` tell a worker what to write; `contract-plan.ts` decides
 * whether what it wrote parses, and rejects a non-conforming plan before any executor starts. The
 * two were stated independently — and so was the test above meant to protect them, which compares
 * its own string literal to the prompt's. All three agreed by coincidence: rename
 * `DEPENDENCIES_FIELD_LABEL` in the validator and every assertion in this file still passes while
 * the generator emits plans the validator can no longer read. This project has shipped exactly that
 * class of generator/validator split before.
 *
 * These cases import the validator's own constants, so the literals can only ever agree on purpose.
 */
describe('plan prompts and the plan validator share one vocabulary', () => {
  const bothPrompts = [
    ['plan/implement.md', planImpl],
    ['plan/review.md', planRev],
  ] as const;

  it.each(bothPrompts)('%s states the exact plan-boundary sentinel', (_name, text) => {
    expect(text).toContain(PLAN_BOUNDARY_SENTINEL);
  });

  it.each(bothPrompts)('%s states the exact Output and Dependencies labels', (_name, text) => {
    expect(text).toContain(OUTPUT_FIELD_LABEL);
    expect(text).toContain(DEPENDENCIES_FIELD_LABEL);
  });

  it.each(bothPrompts)('%s names every Contract bullet the validator requires, in order', (name, text) => {
    // Order matters to the validator, and a prompt listing them in another order would teach the
    // worker to write a plan that parses inconsistently.
    const positions = CONTRACT_BULLET_LABELS.map((label) => {
      const at = text.indexOf(label);
      expect(at, `${name} never states the Contract bullet "${label}"`).toBeGreaterThanOrEqual(0);
      return at;
    });
    expect(positions, `${name} lists the Contract bullets out of validator order`)
      .toEqual([...positions].sort((a, b) => a - b));
  });

  it('the reviewer names the optional declared-checks section by its parsed marker', () => {
    expect(planRev).toContain(CHECKS_HEADING_MARKER);
  });

  it('the generator names every check root the validator accepts', () => {
    // The prompt taught six of the seven; `src/test` was accepted by the validator and mentioned
    // nowhere, so a Maven-layout deliverable was steered away from its natural location. The
    // mismatch was benign in direction (the validator accepted a superset, so no plan was
    // rejected), which is precisely why nothing surfaced it.
    for (const root of ACCEPTED_CHECK_ROOTS) {
      expect(planImpl, `plan/implement.md never names the accepted check root "${root}"`)
        .toContain(`\`${root}\``);
    }
  });

  it('the generator emits the task heading shape the validator matches', () => {
    // Same roman-numeral form as TASK_HEADING_RE (`^###\s+Task\s+[IVXLCDM]+-\d+:`).
    expect(planImpl).toMatch(/###\s+Task\s+[IVXLCDM]+-(?:N|\d+)\s*:/);
  });
});

/**
 * The task-heading rule must describe the heading the validator accepts.
 *
 * `plan/implement.md` said tasks are numbered "`### Task I-N:` — roman-numeral N". `TASK_HEADING_RE`
 * is `/^###\s+Task\s+[IVXLCDM]+-\d+:/` — the segment after the hyphen must be ARABIC digits. A plan
 * numbered `### Task I-IV:` matches no heading, so `parseContractPlan` finds zero tasks and throws
 * `unsupported-legacy-plan`, failing the entire execute_plan before a provider session opens. The
 * same file states the rule correctly 80 lines later ("roman-`I` + `-N`") and its JSON example uses
 * `Task I-1`, so the prompt disagreed only with itself in the one place a worker reads first.
 */
describe('the plan task-heading rule matches the validator', () => {
  it('the validator requires arabic digits after the hyphen', () => {
    const re = /^###\s+Task\s+[IVXLCDM]+-\d+:.*$/gm;
    expect(re.test('### Task I-4: something')).toBe(true);
    re.lastIndex = 0;
    expect(re.test('### Task I-IV: something')).toBe(false);
  });

  it('the prompt no longer calls N a roman numeral', () => {
    expect(planImpl).not.toMatch(/roman-numeral N/);
    expect(planImpl, 'it must say the number is arabic').toMatch(/ARABIC digit/);
  });

  it('and names the failure a roman number would cause', () => {
    expect(planImpl).toContain('unsupported-legacy-plan');
  });
});
