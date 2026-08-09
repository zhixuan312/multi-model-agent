import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Incidental tilt — the success metric the specification froze, implemented.
 *
 * "Incidental tilt" is software vocabulary that misleads a NON-software worker. "Intrinsic tilt"
 * is vocabulary a route genuinely needs, such as code-review technique. Only incidental tilt is
 * capped, which is why the generic assets have a ceiling and the `implement-software.md` assets
 * do not — a software asset is SUPPOSED to be dense with these words.
 *
 * The specification defines this measurement precisely (lexicon, corpus, ratio, thresholds) and
 * cites it from AC-6.4, AC-7.2 and AC-7.5. It was never implemented, so nothing prevented the
 * generic prose from drifting back toward code vocabulary — the exact failure the release exists
 * to prevent, since a business user cannot act on "treat your report like a codebase".
 *
 * What this test is NOT: evidence of prose quality. A ratio measures vocabulary, not depth. A file
 * can contain every measured word and still give shallow advice, which is why FR-16b demands a
 * BEHAVIOURAL fixture for software depth and explicitly refuses a vocabulary metric as evidence.
 * See `software-practice-regression.test.ts` for that half.
 */

/** The frozen lexicon, verbatim from the specification's "frozen measurement" block. */
const LEXICON = [
  'codebase', 'repo', 'repository', 'refactor', 'compile', 'build', 'test suite', 'unit test',
  'typescript', 'javascript', 'function', 'module', 'endpoint', 'API', 'source code',
  'implementation', 'package', 'import', 'symbol', 'lint', 'commit', 'branch', 'PR', 'merge',
  'git', 'file path', 'src/', '.ts', 'regression', 'bug', 'deploy',
];

/** Generic assets and caller-facing skills must not exceed this. */
const GENERIC_CAP = 0.25;
/** A software asset must stay within this band of its route's pre-change baseline. */
const SOFTWARE_BAND = 0.05;

/**
 * Pre-change baselines: the ratio of each route's GENERIC implementer at `master`, before the
 * code technique moved out. Frozen as constants rather than recomputed from git, because a test
 * that derives its own expectation from a moving branch cannot fail.
 *
 * Measured 2026-08-09 at master (a252eaa9's descendant line).
 */
const BASELINE: Record<string, number> = {
  plan: 0.214724,
  execute_plan: 0.052632,
  review: 0.433962,
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive whole-word matches for alphabetic terms; literal matches for terms carrying
 *  punctuation (`src/`, `.ts`), where a word boundary would not apply. */
function tiltRatio(text: string): number {
  const lineCount = text.split('\n').length;
  let matches = 0;
  for (const term of LEXICON) {
    const pattern = /^[a-z ]+$/i.test(term) ? `\\b${esc(term)}\\b` : esc(term);
    matches += (text.match(new RegExp(pattern, 'gi')) ?? []).length;
  }
  return matches / lineCount;
}

const read = (path: string) => readFileSync(path, 'utf8');
const ROUTES = ['plan', 'execute_plan', 'review'] as const;

describe('incidental tilt — generic assets stay deliverable-neutral', () => {
  it.each(ROUTES)('generic %s implementer is at or under the cap', (route) => {
    const ratio = tiltRatio(read(`packages/core/src/skills/${route}/implement.md`));
    expect(ratio, `generic ${route} ratio ${ratio.toFixed(3)} exceeds ${GENERIC_CAP}`)
      .toBeLessThanOrEqual(GENERIC_CAP);
  });

  // FR-18: leaving ONE stage software-shaped is enough to make a whole non-software flow read
  // wrong to its user, so the caller-facing surfaces are swept against the same threshold.
  const CALLER_FACING = [
    'mma-explore', 'mma-brainstorm', 'mma-plan', 'mma-execute-plan',
    'mma-review', 'mma-investigate', 'mma-debug', 'multi-model-agent',
  ];
  it.each(CALLER_FACING)('caller-facing skill %s is at or under the cap', (skill) => {
    const ratio = tiltRatio(read(`packages/server/src/skills/${skill}/SKILL.md`));
    expect(ratio, `${skill} ratio ${ratio.toFixed(3)} exceeds ${GENERIC_CAP}`)
      .toBeLessThanOrEqual(GENERIC_CAP);
  });
});

describe('incidental tilt — software assets kept their technique', () => {
  /**
   * The band proves the technique was MOVED rather than diluted: a software asset that drifted
   * far below its route's pre-change generic ratio has lost vocabulary the technique is made of.
   *
   * Note for a future reader: `execute_plan` currently sits at +0.0499 of a 0.05 band, and that
   * is expected rather than alarming. Its pre-change generic implementer carried almost no code
   * technique (baseline 0.0526), so its software asset was newly AUTHORED rather than relocated —
   * unlike `review`, whose delta is exactly 0.000000 because its technique moved verbatim. A small
   * future edit to `execute_plan/implement-software.md` will trip this assertion; when it does,
   * re-measure and move the baseline deliberately rather than widening the band.
   */
  it.each(ROUTES)('software %s stays within the band of its pre-change baseline', (route) => {
    const ratio = tiltRatio(read(`packages/core/src/skills/${route}/implement-software.md`));
    const delta = Math.abs(ratio - BASELINE[route]);
    expect(delta, `software ${route} ratio ${ratio.toFixed(6)} is ${delta.toFixed(6)} from baseline ${BASELINE[route]}`)
      .toBeLessThanOrEqual(SOFTWARE_BAND);
  });

  it('every software asset is denser in code vocabulary than its generic counterpart', () => {
    // The direction of the difference is the point: if a software asset were NOT denser, the
    // technique would not actually be in it, and the band alone cannot catch that — a generic and
    // a software file could both sit near the baseline while neither carried the craft.
    for (const route of ROUTES) {
      const generic = tiltRatio(read(`packages/core/src/skills/${route}/implement.md`));
      const software = tiltRatio(read(`packages/core/src/skills/${route}/implement-software.md`));
      expect(software, `software ${route} (${software.toFixed(3)}) must exceed generic (${generic.toFixed(3)})`)
        .toBeGreaterThan(generic);
    }
  });
});
