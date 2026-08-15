/**
 * Every packaged skill directory must be in exactly one roster, and the split must match the
 * frontmatter that decides it.
 *
 * `SUPPORTED_SKILLS` and `SUPPORTED_COMMANDS` in `discover.ts` are hand-maintained lists, and
 * nothing compared either of them to `packages/server/src/skills/`. A directory added there and
 * forgotten in the roster still ships — the build does `cp -R src/skills dist/skills` and the
 * package publishes `dist` — but `recordProvisionedSkills` and every provisioning writer iterate
 * the ROSTER, so it is installed for no client and matched by no intent. Present on disk,
 * unreachable in practice, and nothing red anywhere.
 *
 * The split is not a matter of taste either: `disable-model-invocation: true` in the frontmatter
 * is what makes a directory an explicitly-invoked command rather than an auto-matched skill. So
 * that frontmatter — not a third list — decides which roster a directory belongs to, and this
 * test reads it rather than restating it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import {
  SUPPORTED_COMMANDS,
  SUPPORTED_SKILLS,
} from '../../packages/server/src/skill-install/discover.js';

const SKILLS_DIR = 'packages/server/src/skills';

/** `_shared` holds `@include` fragments, not a skill — it has no SKILL.md. */
const NOT_A_SKILL = new Set(['_shared']);

const packaged = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !NOT_A_SKILL.has(entry.name))
  .map((entry) => entry.name)
  .sort();

/** True when the directory's frontmatter opts out of automatic matching — i.e. it is a command. */
function isCommand(name: string): boolean {
  const { data } = matter(readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8'));
  return data['disable-model-invocation'] === true;
}

describe('packaged skill rosters cover the packaged directory', () => {
  it('finds the packaged directories', () => {
    expect(packaged.length).toBeGreaterThan(15);
  });

  it('every packaged directory is in exactly one roster', () => {
    const rostered = [...SUPPORTED_SKILLS, ...SUPPORTED_COMMANDS].sort();
    expect(rostered).toEqual(packaged);

    // …and no name is in both, which `toEqual` on sorted arrays would not catch on its own if a
    // duplicate happened to pair with a missing directory.
    expect(new Set(rostered).size).toBe(rostered.length);
  });

  it('the roster split matches the frontmatter that enforces it', () => {
    expect([...SUPPORTED_COMMANDS].sort()).toEqual(packaged.filter(isCommand));
    expect([...SUPPORTED_SKILLS].sort()).toEqual(packaged.filter((name) => !isCommand(name)));
  });
});
