import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseContractPlan } from '@zhixuan92/multi-model-agent-core';

/**
 * AC-1.1 — the engine's own documentation must describe the deliverable-agnostic interface
 * ACCURATELY.
 *
 * The specific drift this guards: after the Contract Task grammar made the Checks section
 * OPTIONAL, two public summaries still told readers that every plan task carries "plan-authored
 * acceptance tests". That single phrase reintroduces the assumption the release removed. A reader
 * who believes a check is mandatory will either force a fake check onto a criterion no machine can
 * settle, or conclude their non-code deliverable is unsupported — the exact fault that blocked
 * every non-code deliverable before this release.
 *
 * Documentation drift is normally invisible to a test suite, which is why it survived. This test
 * pins the BEHAVIOUR and the PROSE together: the parser genuinely accepts a checkless task, and
 * the public documents must not claim otherwise.
 */

const read = (path: string) => readFileSync(path, 'utf8');

/** A Contract Task with no Checks section — the shape the documentation must not contradict. */
const NO_CHECK_PLAN = [
  '### Task I-1: Write the quarterly commentary',
  '',
  '**Output:** `report/commentary.md`',
  '**Dependencies:** approved figures',
  '',
  '**Contract:**',
  '- Inputs / Request: the reconciled figures',
  '- Outputs / Response: a written commentary section',
  '- Data mapping: each statement traces to a figure',
  '- Errors: an unreconciled figure blocks the section',
  '- Behavior / invariants: no figure is restated without its source',
  '',
  '**Plan boundary:** final deliverable content is not in this plan.',
].join('\n');

describe('AC-1.1 — public documentation matches the optional-check behaviour', () => {
  it('the parser really does accept a task with no declared check', () => {
    // Asserting the behaviour first means the prose assertions below are anchored to something
    // real. If this ever fails, the documentation is not the thing that needs changing.
    const task = parseContractPlan(NO_CHECK_PLAN).tasks[0];
    expect(task.id).toBe('I-1');
    expect(task.acceptanceTests).toEqual([]);
  });

  it('no public document claims every plan task carries acceptance tests', () => {
    const CLAIMS = [
      'a Contract plus plan-authored acceptance tests',
      'Contract + plan-authored acceptance tests',
    ];
    for (const path of ['README.md', 'packages/server/README.md']) {
      const body = read(path);
      for (const claim of CLAIMS) {
        expect(body, `${path} still claims checks are mandatory: "${claim}"`).not.toContain(claim);
      }
    }
  });

  it('the root README states plainly that a checkless task is valid', () => {
    // A reader must be able to learn this WITHOUT reading the parser. Removing the wrong claim is
    // not sufficient on its own; silence would leave the same wrong assumption in place.
    const body = read('README.md').toLowerCase();
    expect(body).toContain('declares no check');
  });
});
