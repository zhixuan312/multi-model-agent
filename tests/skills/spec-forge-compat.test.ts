import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SPEC_COMPONENT_CATALOG } from '@zhixuan92/multi-model-agent-core';

// The eight component IDENTIFIERS (also the wire `components` enum and the JSON output
// `sections` array) stay byte-identical to what Forge matches. Three of them now render as
// a neutral DISPLAYED heading in the spec file itself — see `SPEC_COMPONENT_CATALOG` in
// `@zhixuan92/multi-model-agent-core`. `resolveComponentHeading` dual-reads both forms back
// to the same stable identifier.
//
// Both lists below are written out DELIBERATELY rather than derived from that catalog, and must
// stay that way. They record what a SEPARATE repository matches on; a test that derived them
// would follow a rename into agreement with itself and report green while Forge stopped parsing
// specs. Renaming an identifier here should cost a deliberate edit in this file — that edit is
// the reminder that another repo has to change too.
const FORGE_COMPONENT_IDENTIFIERS = [
  'Context',
  'Problem',
  'Goals & Requirements',
  'Alternatives',
  'Technical Design',
  'Testing Plan',
  'Risks & Mitigations',
  'User Stories & Tasks',
];

const FORGE_DISPLAYED_HEADINGS = [
  'Context',
  'Problem',
  'Goals & Requirements',
  'Alternatives',
  'Approach, Method & Structure',
  'Verification Plan',
  'Risks & Mitigations',
  'Stakeholders & Work',
];

/**
 * The ENGINE's catalog, held to the same literals as the prompt.
 *
 * The lists above pin `implement.md`. Nothing pinned `SPEC_COMPONENT_CATALOG`, which is what
 * `resolveComponentHeading` reads: it was covered by `toHaveLength(8)` — a count, which any
 * rename satisfies — plus a single spot-check of `Technical Design`. Rename `Verification Plan`
 * or `Stakeholders & Work` in code and every test stays green while the worker, following the
 * prompt, writes a heading the engine no longer maps to any component.
 *
 * Pairing them here is the point: the prompt tells the worker what to WRITE and the catalog tells
 * the engine what to READ, so they are the same contract seen from two ends, and Forge is a third
 * reader of it. Deriving either side from the other would just make a rename agree with itself.
 */
describe('the engine catalog matches the headings the prompt tells workers to write', () => {
  it('every identifier maps to the displayed heading Forge and the prompt expect', () => {
    expect(SPEC_COMPONENT_CATALOG.map((entry) => entry.id)).toEqual(FORGE_COMPONENT_IDENTIFIERS);
    expect(SPEC_COMPONENT_CATALOG.map((entry) => entry.displayLabel)).toEqual(FORGE_DISPLAYED_HEADINGS);
  });
});

describe('mma-spec prompts: subset-aware Forge-compatible structure', () => {
  const implMd = readFileSync('packages/core/src/skills/spec/implement.md', 'utf8');
  const reviewMd = readFileSync('packages/core/src/skills/spec/review.md', 'utf8');

  it('implementer template still contains all 8 canonical component headings, using their displayed labels', () => {
    for (const label of FORGE_DISPLAYED_HEADINGS) {
      expect(implMd, `missing ## ${label}`).toContain(`## ${label}`);
    }
  });

  it('implementer prompt still names every stable identifier alongside its displayed heading', () => {
    for (const identifier of FORGE_COMPONENT_IDENTIFIERS) {
      expect(implMd, `missing identifier ${identifier}`).toContain(identifier);
    }
  });

  it('implementer instructions say requested components default to all 8', () => {
    expect(implMd).toContain('requested components');
    expect(implMd).toContain('default all 8');
    expect(implMd).toContain('exactly equal to the resolved component set');
    expect(implMd).toContain('zero `<!-- brief:` markers remain');
  });

  /**
   * Presence is not agreement.
   *
   * Every assertion above is `toContain`, so a prompt satisfies all of them while ALSO carrying
   * the opposite instruction — and that is what happened. Phase D asked for both "exactly equal
   * to the resolved component set" (line 263) and "All 8 `##` component headings are present"
   * (line 265), two lines apart, with Phase B repeating the all-eight framing twice more. Only
   * the line-232 catalog was updated when subset mode landed.
   *
   * A worker asked for three components and running its own self-validation is told its correct
   * output is wrong and must grow five more; the refiner then deletes them (review.md's "remove
   * any component emitted but not requested"). Best case that burns turns on both sides of the
   * pipeline. Worst case the eight-component spec is what ships, and Forge's subset SDLC — where
   * a project is deliberately scoped to a contiguous slice — silently stops being a subset.
   *
   * The rule this pins: any sentence that REQUIRES component headings and names a count must say
   * whose count it is. An unqualified one is a contradiction waiting to be obeyed.
   */
  it.each([
    ['implement.md', implMd],
    ['review.md', reviewMd],
  ])('%s never requires a component count without scoping it to the request', (file, text) => {
    const offenders = text.split('\n').filter((line) => {
      if (!/component/i.test(line)) return false;
      if (!/\b(all\s*8|all eight|the 8|8 component|eight component)\b/i.test(line)) return false;
      if (!/\b(must|present|every)\b/i.test(line)) return false;
      return !/request|resolved|subset/i.test(line);
    });
    expect(offenders, `${file} states an unconditional component-count requirement`).toEqual([]);
  });

  it('refiner instructions scope work to requested components and gate cross-component checks', () => {
    expect(reviewMd).toContain('requested components');
    expect(reviewMd).toContain('Goals & Requirements');
    expect(reviewMd).toContain('User Stories & Tasks');
    expect(reviewMd).toContain('skipped if either is absent');
    expect(reviewMd).toContain('exactly equal to the resolved component set');
    expect(reviewMd).toContain('`sections` must list exactly the resolved component set');
  });
});
