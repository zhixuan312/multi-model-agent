import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Incidental tilt — the success metric the specification froze, implemented.
 *
 * "Incidental tilt" is software vocabulary that misleads a NON-software worker. "Intrinsic tilt"
 * is vocabulary a route genuinely needs, such as code-review technique. Only incidental tilt is
 * capped, which is why the generic assets have a ceiling.
 *
 * The specification defines this measurement precisely (lexicon, corpus, ratio, thresholds) and
 * cites it from AC-6.4, AC-7.2 and AC-7.5. It was never implemented, so nothing prevented the
 * generic prose from drifting back toward code vocabulary — the exact failure the release exists
 * to prevent, since a business user cannot act on "treat your report like a codebase".
 *
 * What this test is NOT: evidence of prose quality. A ratio measures vocabulary, not depth. A file
 * can contain every measured word and still give shallow advice, which is why FR-16b demands a
 * BEHAVIOURAL fixture for software depth and explicitly refuses a vocabulary metric as evidence.
 *
 * SPEC-005 Task I-6 retired the legacy software-specific assets this file used to measure
 * separately (they are gone, and their technique now lives in the committed
 * `software-change@1` Method guidance instead) — the software-asset-band describe block below
 * is retired along with them. The generic-asset ceiling below is unaffected.
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
