import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERIFICATION_METHODS } from '@zhixuan92/multi-model-agent-core';

/**
 * AC-3.5 — "The spec AND plan skills instruct the worker to select the method the claim's nature
 * requires … and to state why."
 *
 * The spec skill did this. The plan skill did not: it knew only about deterministic checks, so a
 * plan could not express an acceptance criterion needing `agent-review` or `human`. That is a
 * narrower failure than it looks. The plan is where a task binds to its acceptance criterion, so a
 * plan that knows one method silently reduces "acceptance" to "testing" — and acceptance is
 * deliberately broader than testing. The claims that fall through are exactly the ones that most
 * need a named owner: professional sign-offs, judgement calls, anything a machine cannot settle.
 *
 * The generic plan asset is checked. It needs this because most of its deliverables cannot be
 * settled by a command at all. (The legacy software-specific plan asset that used to carry the
 * same requirement was retired by SPEC-005 Task I-6 — the software technique now lives in the
 * committed `software-change@1` Method guidance instead, which is out of scope for this AC.)
 */

const PLAN_ASSETS = [
  'packages/core/src/skills/plan/implement.md',
];

const read = (path: string) => readFileSync(path, 'utf8');

describe('AC-3.5 — the plan skill selects a verification method per criterion', () => {
  it.each(PLAN_ASSETS)('%s names all three verification methods', (path) => {
    const body = read(path);
    for (const method of VERIFICATION_METHODS) {
      expect(body, `${path} must name the '${method}' method`).toContain(method);
    }
  });

  it.each(PLAN_ASSETS)('%s ties the choice to what the CLAIM requires', (path) => {
    expect(read(path).toLowerCase()).toContain('choose the method the claim requires');
  });

  it.each(PLAN_ASSETS)('%s forbids substituting agent-review for human authority', (path) => {
    // The one substitution that destroys accountability, and the tempting one: a model can always
    // produce a confident-sounding opinion where a named person is required.
    expect(read(path)).toContain('never a substitute for `human`');
  });

  it('the generic asset states that a declared Check is only the command method', () => {
    // Without this, "no Check" reads as "no verification" rather than "verified another way".
    const body = read('packages/core/src/skills/plan/implement.md');
    expect(body).toContain('the only method that produces one');
    expect(body.toLowerCase()).toContain('acceptance is broader than testing');
  });

  it('the generic asset requires a checkless task to say how the claim IS established', () => {
    const body = read('packages/core/src/skills/plan/implement.md').toLowerCase();
    expect(body).toContain('a missing check is a statement, not an omission');
  });

  it('states that method selection is a review obligation, not an engine gate', () => {
    // AC-3.5 is explicit that the engine records the declaration and never refuses a criterion for
    // its choice of method. A plan asset implying the engine enforces this would mislead the
    // worker into expecting a dispatch-time error that never comes.
    expect(read('packages/core/src/skills/plan/implement.md')).toContain('not an engine gate');
  });
});
