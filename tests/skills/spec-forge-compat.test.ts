import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

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

  it('refiner instructions scope work to requested components and gate cross-component checks', () => {
    expect(reviewMd).toContain('requested components');
    expect(reviewMd).toContain('Goals & Requirements');
    expect(reviewMd).toContain('User Stories & Tasks');
    expect(reviewMd).toContain('skipped if either is absent');
    expect(reviewMd).toContain('exactly equal to the resolved component set');
    expect(reviewMd).toContain('`sections` must list exactly the resolved component set');
  });
});
