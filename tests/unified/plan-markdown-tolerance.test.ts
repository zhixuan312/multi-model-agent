import { describe, expect, it } from 'vitest';
import { parseContractPlan } from '@zhixuan92/multi-model-agent-core';

/**
 * A Contract Task must survive ordinary markdown around it.
 *
 * Reported from real use against the previous grammar: `execute_plan` rejected a plan because a
 * blockquote split a `**Files:**` block. That grammar declared a task's metadata as a MULTI-LINE
 * list, so any prose interleaved into the list broke the parse, and the caller had to abandon
 * `execute_plan` for `delegate`.
 *
 * The current grammar states each metadata field on ONE line (`**Output:**`, `**Dependencies:**`),
 * which removes the multi-line block a blockquote could split. These tests pin that property, so
 * a future grammar change cannot quietly reintroduce a shape that ordinary prose can break. Plans
 * are written by models and pasted through renderers; tolerating a stray blockquote is not a
 * nicety, it is the difference between a route being usable and a caller routing around it.
 */

const CONTRACT_BODY = [
  '**Contract:**',
  '- Inputs / Request: the reconciled figures',
  '- Outputs / Response: a written section',
  '- Data mapping: each claim traces to a figure',
  '- Errors: a missing figure blocks the section',
  '- Behavior / invariants: no figure is restated without its source',
  '',
  '**Plan boundary:** final deliverable content is not in this plan.',
];

describe('Contract Task parsing tolerates surrounding markdown', () => {
  it('parses a task whose whole body is inside a blockquote', () => {
    const plan = [
      '### Task I-1: Produce the section (← AC-1)',
      '',
      '> **Output:** `report/section.md`',
      '> **Dependencies:** none',
      '',
      ...CONTRACT_BODY.map((line) => (line ? `> ${line}` : '>')),
    ].join('\n');
    const parsed = parseContractPlan(plan);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]!.id).toBe('I-1');
  });

  it('parses a task with a blockquote interrupting its metadata', () => {
    // The exact shape that broke the previous grammar: prose between two metadata fields.
    const plan = [
      '### Task I-1: Produce the section (← AC-1)',
      '',
      '**Output:** `report/section.md`',
      '',
      '> Note: the figures come from the reconciled ledger, not the draft.',
      '',
      '**Dependencies:** none',
      '',
      ...CONTRACT_BODY,
    ].join('\n');
    const parsed = parseContractPlan(plan);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]!.output).toContain('report/section.md');
    expect(parsed.tasks[0]!.dependencies).toBe('none');
  });

  it('still rejects a task that genuinely omits a required field', () => {
    // Tolerance must not become permissiveness: a MISSING field is still an error, because the
    // executor and the reviewer have nothing else to work from.
    const plan = [
      '### Task I-1: Produce the section (← AC-1)',
      '',
      '**Dependencies:** none',
      '',
      ...CONTRACT_BODY,
    ].join('\n');
    expect(() => parseContractPlan(plan)).toThrow(/Output/);
  });
});
