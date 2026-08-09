import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * AC-6.8 and AC-6.9 — the GENERIC plan implementer.
 *
 * These two criteria are the other half of the release's central move. AC-6.2 asks that software
 * technique stay reachable behind `practice`; AC-6.8 and AC-6.9 ask that what remains in the
 * generic file actually serve a non-software deliverable. Moving the code technique OUT is not the
 * same as making the remainder neutral: the generic file kept telling every worker to "explore the
 * codebase (tech stack, test runner, import style, build/run commands)" and to size tasks as "one
 * endpoint, one mapping, one module within a single repository/package", which is a software
 * instruction handed to someone writing a finance report.
 *
 * Nothing is lost for software work, because `plan/implement-software.md` carries the codebase
 * ground-truth step and the module-level granularity itself — a `practice: 'software'` dispatch
 * loads that file INSTEAD of this one.
 */

const generic = () => readFileSync('packages/core/src/skills/plan/implement.md', 'utf8');
const software = () => readFileSync('packages/core/src/skills/plan/implement-software.md', 'utf8');

describe('AC-6.8 — the generic plan implementer assumes no code project', () => {
  it('does not send every worker to explore a codebase for ground truth', () => {
    // The exact instruction that used to be here. It belongs in the software asset only.
    expect(generic()).not.toContain('explore the codebase');
  });

  it('does not size tasks in code units inside a repository', () => {
    const body = generic();
    expect(body).not.toContain('within a single repository/package');
    expect(body).not.toContain('one endpoint, one mapping,');
  });

  it('tells the worker not to assume a suite, a build, or a repository', () => {
    expect(generic().toLowerCase()).toContain('assume no test suite');
  });

  it('requires phases to end where a person can review', () => {
    expect(generic().toLowerCase()).toContain('a person can actually review');
  });

  it('does not mandate a test/build/lint gate the deliverable may not have', () => {
    // The contradiction this guards: the same file told the writer to assume no test suite, build
    // or repository, and then to close every plan with a "Full-suite gate (test/build/lint)". A
    // finance report has none of those, so the closing step silently reimposed the software
    // assumption the rest of the file had just removed.
    const body = generic();
    expect(body).not.toContain('Full-suite gate (test/build/lint, expected PASS)');
    // A whole-deliverable gate is still REQUIRED — per-task checks never prove the assembled
    // result is sound. Only its form is left to the deliverable.
    expect(body).toContain('whole-deliverable gate');
    expect(body.toLowerCase()).toContain('unless you confirmed in step 1');
  });
});

describe('AC-6.9 — the plan states its chosen production method', () => {
  it('requires the production method to be named in prose', () => {
    const body = generic();
    expect(body).toContain('State the production method');
    // The AC names this exact example: facts / calculations / assumptions / interpretation kept apart.
    expect(body.toLowerCase()).toContain('assumptions and interpretation separated');
  });
});

describe('the software path keeps everything the generic path gave up', () => {
  it('retains codebase ground truth and code-unit granularity', () => {
    const body = software();
    expect(body).toContain('explore the codebase');
    expect(body).toContain('within a single repository/package');
  });
});
