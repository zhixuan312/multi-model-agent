import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * AC-6.2, second clause: "A flow's persisted `FlowRouting` value drives every one of its
 * dispatches, so no flow plans with the software technique and reviews generically."
 *
 * The first clause of AC-6.2 — `practice: 'software'` loads `implement-software.md` — is covered
 * by `software-practice-regression.test.ts`, which reads the ASSET FILES. That test passes
 * whether or not anything ever selects those assets, and for one release it did exactly that:
 * the four `implement-software.md` files shipped while no caller-facing surface mentioned
 * `practice` at all, so every code plan, execution, review and diagnosis dispatched through the
 * packaged skills silently took the deliverable-neutral path. The retained technique was present
 * in the file and unreachable in the flow.
 *
 * This test guards REACHABILITY, which is a different property from existence: the caller must be
 * told the field exists, told the rule for setting it, and told to read one persisted value per
 * flow rather than deciding per dispatch.
 */

const read = (path: string) => readFileSync(path, 'utf8');

/** The four routes that accept `practice` (task-input-schema.ts). `audit` is deliberately absent —
 *  it keeps its own `subtype`, which answers a different question. */
const ROUTED_SKILLS = [
  'packages/server/src/skills/mma-plan/SKILL.md',
  'packages/server/src/skills/mma-execute-plan/SKILL.md',
  'packages/server/src/skills/mma-review/SKILL.md',
  'packages/server/src/skills/mma-debug/SKILL.md',
];

describe('practice routing is reachable by a caller', () => {
  it('documents the practice field on every routed packaged skill', () => {
    for (const path of ROUTED_SKILLS) {
      const body = read(path);
      expect(body, `${path} must document the practice field`).toContain('`practice`');
      expect(body, `${path} must name the only shipped value`).toContain('software');
    }
  });

  it('states the technique-not-artifact rule rather than "the artifact is code"', () => {
    // The rule decides the boundary cases (n8n, Terraform, SQL, notebooks). A skill that says
    // "set this when the output is code" gives the wrong answer for every one of them.
    for (const path of ROUTED_SKILLS) {
      const body = read(path).toLowerCase();
      expect(body, `${path} must state the technique rule`).toContain('code-level technique is required');
    }
  });

  it('never tells the engine to infer practice', () => {
    for (const path of ROUTED_SKILLS) {
      expect(read(path)).toContain('NEVER infers');
    }
  });

  it('gives mma-flow one persisted routing value read on every dispatch', () => {
    const flow = read('packages/server/src/skills/mma-flow/SKILL.md');
    // Persisted, in the caller-owned flow state — not decided per dispatch.
    expect(flow).toContain('routing');
    expect(flow).toContain('.mma/flow-state/<stem>.json');
    expect(flow).toContain('practice');
    // The specific failure AC-6.2 names: planning with software technique, reviewing generically.
    expect(flow.toLowerCase()).toContain('reviews generically');
  });

  it('keeps practice out of audit, which routes on subtype instead', () => {
    const audit = read('packages/server/src/skills/mma-audit/SKILL.md');
    // `audit` must not gain a `practice` request field (AC-6.6). "Best practices" is a heading,
    // not a field, so the assertion targets the backticked field spelling only.
    expect(audit).not.toContain('| `practice`');
  });
});
