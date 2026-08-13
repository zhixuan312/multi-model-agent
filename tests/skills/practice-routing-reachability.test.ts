import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * SPEC-005 Task I-6: the retired technique-selector mechanism (the request field, its four
 * `implement-<selector>.md` assets, and mma-flow's "Common: Practice routing" section) is gone.
 * This test used to guard REACHABILITY of that mechanism (AC-6.2) — that a caller was actually
 * told the field existed, not merely that the asset files were present on disk. Now it guards the
 * opposite direction: that the retired mechanism does not resurface in the packaged skill
 * documents that used to advertise it. "Best practices" headings are ordinary English and are
 * deliberately allowed to remain.
 */

const read = (path: string) => readFileSync(path, 'utf8');

/** The four routes that used to accept the retired field. `audit` is deliberately absent —
 *  it keeps its own `subtype`, which answers a different question. */
const FORMERLY_ROUTED_SKILLS = [
  'packages/server/src/skills/mma-plan/SKILL.md',
  'packages/server/src/skills/mma-execute-plan/SKILL.md',
  'packages/server/src/skills/mma-review/SKILL.md',
  'packages/server/src/skills/mma-debug/SKILL.md',
];

// Named constant, referenced via string concatenation below rather than written inline as a
// backtick-wrapped literal — this file is itself named in the practice-removal-sweep's
// `scopedFiles` list, so it must never carry the exact markdown spelling it is checking for.
const RETIRED_FIELD = 'practice';

describe('the retired technique-selector field is not documented anywhere it used to be', () => {
  it('no longer documents the retired field on any formerly-routed packaged skill', () => {
    for (const path of FORMERLY_ROUTED_SKILLS) {
      const body = read(path);
      expect(body, `${path} must not document the retired field`).not.toContain('`' + RETIRED_FIELD + '`');
    }
  });

  it('mma-flow no longer persists a routing value for the retired field', () => {
    const flow = read('packages/server/src/skills/mma-flow/SKILL.md');
    expect(flow).not.toContain('routing.' + RETIRED_FIELD);
    expect(flow).not.toContain('Common: Practice routing');
  });

  it('keeps the retired field out of audit, which routes on subtype instead', () => {
    const audit = read('packages/server/src/skills/mma-audit/SKILL.md');
    // `audit` must not gain a retired-field request row (AC-6.6). "Best practices" is a heading,
    // not a field, so the assertion targets the backticked field spelling only.
    expect(audit).not.toContain('| `' + RETIRED_FIELD + '`');
  });
});
