/**
 * Every skill that documents a findings array must also document what an empty one means.
 *
 * The list of files was hardcoded to five. `mma-journal-recall` documents
 * `output.summary.findings` like the other five, and was not among them — it carried the same two
 * paragraphs under a different heading, `## Interpreting the result`, so a caller (or a grep, or
 * this test) looking for the section did not find it. The heading is now uniform, and the file
 * list is derived: a skill that documents findings is a skill that must say what zero of them
 * means, and adding a sixth route cannot quietly opt out of that.
 *
 * "Empty findings is a success" is the specific thing worth pinning. It is the outcome a caller
 * is most likely to mishandle — an audit that finds nothing, a recall with no prior learnings —
 * and reading it as a failure turns a clean result into a retry.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_ROOT = 'packages/server/src/skills';

/**
 * `mma-explore` mentions `output.summary.findings` while describing how to read the results of
 * the investigate / research / journal-recall dispatches IT fans out — it is a main-agent
 * orchestration skill and returns no envelope of its own, so it has no terminal outcome to
 * document. Named here rather than filtered by a cleverer pattern, so the exception is visible.
 */
const NO_ENVELOPE_OF_ITS_OWN = new Set(['mma-explore']);

/** Every packaged skill whose OWN documented response carries a findings array. */
const findingsSkills = readdirSync(SKILLS_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !NO_ENVELOPE_OF_ITS_OWN.has(entry.name))
  .map((entry) => join(SKILLS_ROOT, entry.name, 'SKILL.md'))
  .filter((path) => {
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { return false; }
    // The route's OWN documented output, not the shared envelope description that every skill
    // includes — that one names `summary.findings` only inside the generic per-route-family table.
    return text.includes('output.summary.findings');
  });

describe('skills that return findings document the outcome', () => {
  it('finds the routes to check', () => {
    // audit, review, debug, investigate, research, journal-recall.
    expect(findingsSkills.length).toBeGreaterThanOrEqual(6);
  });

  it.each(findingsSkills)('%s has an Outcome semantics section', (path) => {
    expect(readFileSync(path, 'utf8')).toMatch(/^## Outcome semantics$/m);
  });

  it.each(findingsSkills)('%s states the success check and that an empty result is a success', (path) => {
    const text = readFileSync(path, 'utf8');
    const section = text.slice(text.indexOf('## Outcome semantics'));
    expect(section).toMatch(/`error === null`/);
    // Each route names its own empty thing — "Empty findings", "Empty journal" — so the phrase
    // that must be present is the CLAIM, not one route's noun for it.
    expect(section).toMatch(/is not a failure/i);
    expect(section).toMatch(/is a success/i);
  });
});
