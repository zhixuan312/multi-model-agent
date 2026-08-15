/**
 * `_shared/review-policy.md` is `@include`d into the skills that document `reviewPolicy`, so it is
 * the sentence a calling agent reads before deciding whether to pay for a reviewer.
 *
 * It said "Only `orchestrate` forces `none`. Callers can override per-request." The runtime forces
 * TWO types: `orchestrate` to `'none'` and `execute_plan` to `'reviewed'`. So a caller sending
 * `reviewPolicy: 'none'` to `execute_plan` — the documented way to skip a reviewer on mechanical
 * work — is billed for one anyway, and nothing in the response says the override was dropped.
 *
 * The runtime is RIGHT: contract satisfaction and `completionPercent` are derived from the
 * reviewer's per-task `tasks[]`, so an unreviewed execute_plan has no scoring source. Only the doc
 * was wrong, which is why this test reads the doc against the code rather than the reverse.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const DOC = 'packages/server/src/skills/_shared/review-policy.md';
const RUNTIME = 'packages/server/src/application/execution-runtime.ts';

const doc = readFileSync(DOC, 'utf8');
const runtime = readFileSync(RUNTIME, 'utf8');

/** The types the runtime pins, read out of the resolution expression itself. */
function forcedTypes(): Record<string, string> {
  const expr = /const reviewPolicy = ([\s\S]{0,400}?);/.exec(runtime);
  expect(expr, 'the reviewPolicy resolution moved — this test can no longer read it').not.toBeNull();
  const forced: Record<string, string> = {};
  for (const [, type, value] of expr![1].matchAll(/input\.type === '(\w+)'\s*\?\s*'(\w+)'/g)) {
    forced[type!] = value!;
  }
  return forced;
}

describe('the review-policy doc matches what the runtime forces', () => {
  const forced = forcedTypes();

  it('the runtime forces exactly the types the doc names', () => {
    expect(Object.keys(forced).sort()).toEqual(['execute_plan', 'orchestrate']);
  });

  it.each(Object.entries(forced))('%s is documented as forcing %s', (type, value) => {
    // Both the type and the value it pins must appear, so a doc naming the type while claiming the
    // wrong value is still a failure.
    expect(doc, `${type} forces ${value} at runtime but the doc never says so`).toContain(type);
    expect(doc, `the doc does not state that ${type} forces "${value}"`)
      .toMatch(new RegExp(`${type}[^\\n]*${value}|${value}[^\\n]*${type}`));
  });

  it('does not still claim orchestrate is the only forced type', () => {
    expect(doc).not.toMatch(/Only `orchestrate` forces/);
  });
});
