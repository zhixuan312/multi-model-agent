/**
 * A skill name out of the install manifest is a PATH SEGMENT, and it was joined as if it were one.
 *
 * `install-manifest.json` lives at `~/.mma/install-manifest.json`. Its `entries[].name` is joined
 * straight into `path.join(skillsRoot, name, 'SKILL.md')` by `readSkillContent`, with no check that
 * `name` is a single segment. Two consequences, both reproduced against the compiled build before
 * this was fixed:
 *
 *  1. `name: '..'` reads `<parent-of-skills-root>/SKILL.md` — outside the tree the function is
 *     documented to read from. The content is only scanned for a `version` string, so nothing
 *     escapes; but the read itself is unbounded, and a rule that holds by luck is not a rule.
 *
 *  2. `name: 'mma-audit/SKILL.md'` makes the join `<root>/mma-audit/SKILL.md/SKILL.md`, and
 *     `readFileSync` raises ENOTDIR — which is not ENOENT, so `readSkillContent` rethrows it by
 *     design. That throw then escaped two guards written to stop exactly this:
 *
 *       - `deriveSkillManifestInfo` is documented "Never throws — a future/corrupt manifest degrades
 *         to the unknown shape rather than failing the status response", but its try/catch wraps
 *         only `listEntries()`; the `entries.some(isSkillBehind)` on the next line is outside it. So
 *         `GET /status` answered 500 instead of degrading — on the one request an operator makes to
 *         diagnose a broken install.
 *
 *       - `cli/serve.ts`'s identical catch is commented "best-effort — never let manifest IO issues
 *         block serve", and its `entries.filter(isSkillBehind)` is outside it too. `serve.ts:192`'s
 *         `await maybeAutoUpdateSkills(...)` sits between two try blocks and is inside neither, so
 *         the throw reached the top: one corrupt line in a JSON file, and the daemon does not boot.
 *
 * `cli/doctor.ts` calls `isSkillBehind` the same way — the command you run when the install is
 * already broken would crash on the breakage it exists to report.
 *
 * Fixed at the two roots: `readSkillContent`/`readCommandContent` reject a non-segment name, and
 * `isSkillBehind` reads inside its own try so it degrades like its docstring already promised for
 * unparseable frontmatter. All three callers are covered by those two changes.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSkillContent, readCommandContent } from '../../../packages/server/src/skill-install/discover.js';
import { deriveSkillManifestInfo, isSkillBehind } from '../../../packages/server/src/skill-install/skill-drift.js';

/** A skills root with one real skill, and a decoy SKILL.md one level ABOVE it. */
function fixture(): { base: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'mma-corrupt-name-'));
  const root = join(base, 'skills');
  mkdirSync(join(root, 'mma-audit'), { recursive: true });
  writeFileSync(join(root, 'mma-audit', 'SKILL.md'), '---\nversion: 1.0.0\n---\nbody\n', 'utf8');
  // If a traversing name is honoured, this is what gets read.
  writeFileSync(join(base, 'SKILL.md'), 'OUTSIDE THE SKILLS ROOT', 'utf8');
  return { base, root };
}

/** A home dir whose install manifest names exactly one skill. */
function homeWithManifestName(name: string): string {
  const home = mkdtempSync(join(tmpdir(), 'mma-corrupt-home-'));
  mkdirSync(join(home, '.mma'), { recursive: true });
  writeFileSync(join(home, '.mma', 'install-manifest.json'), JSON.stringify({
    version: 2,
    entries: [{ name, skillVersion: '1.0.0', installedAt: 1_700_000_000_000, targets: ['claude-code'] }],
  }), 'utf8');
  return home;
}

describe('a manifest-supplied skill name cannot leave the skills root', () => {
  it('reads a plain name normally — the floor for the negatives below', () => {
    const { base, root } = fixture();
    try {
      // Without this, every rejection below could be a fixture that simply does not exist.
      expect(readSkillContent('mma-audit', root)).toContain('version: 1.0.0');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    ['..', 'the parent directory'],
    ['../skills/mma-audit', 'a relative walk that lands back inside'],
    ['a/b', 'a nested path'],
    ['mma-audit/SKILL.md', 'the ENOTDIR shape that killed serve boot'],
    ['/etc', 'an absolute path'],
    ['.', 'the root itself'],
  ])('rejects %s (%s) without reading and without throwing', (name) => {
    const { base, root } = fixture();
    try {
      expect(readSkillContent(name, root)).toBeNull();
      expect(readCommandContent(name, root)).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not read the decoy above the root', () => {
    const { base, root } = fixture();
    try {
      expect(readSkillContent('..', root) ?? '').not.toContain('OUTSIDE THE SKILLS ROOT');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('a corrupt manifest degrades instead of throwing', () => {
  it('isSkillBehind answers false for a name it cannot read', () => {
    // Its docstring already promised this for a removed skill and for unparseable frontmatter; an
    // unreadable path is the same "cannot assess" case and now answers the same way.
    expect(() => isSkillBehind('mma-audit/SKILL.md', '1.0.0')).not.toThrow();
    expect(isSkillBehind('mma-audit/SKILL.md', '1.0.0')).toBe(false);
  });

  /**
   * The name guard alone would satisfy the case above, so it no longer proves the OTHER half of the
   * fix (moving the read inside the try). This case does: `mma-broken` is a perfectly valid segment
   * whose SKILL.md is a directory, so `readFileSync` raises EISDIR — a non-ENOENT error that
   * `readSkillContent` still propagates by design, exactly as EACCES on a real install would.
   *
   * chmod is not used to produce the error: on macOS a 0o500 directory does not stop its owner, so
   * a permissions-based fixture passes with the guard removed. EISDIR is refused for everyone.
   */
  it('swallows a read error on a valid name — EACCES on one bundled file must not stop boot', () => {
    const base = mkdtempSync(join(tmpdir(), 'mma-unreadable-'));
    const root = join(base, 'skills');
    try {
      mkdirSync(join(root, 'mma-broken', 'SKILL.md'), { recursive: true }); // a DIRECTORY
      expect(() => isSkillBehind('mma-broken', '1.0.0', root)).not.toThrow();
      expect(isSkillBehind('mma-broken', '1.0.0', root)).toBe(false);

      const home = homeWithManifestName('mma-broken');
      try {
        expect(() => deriveSkillManifestInfo(home, root)).not.toThrow();
        expect(deriveSkillManifestInfo(home, root).skillCompatible).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('deriveSkillManifestInfo keeps its "never throws" contract', () => {
    const home = homeWithManifestName('mma-audit/SKILL.md');
    try {
      // Before the fix this threw ENOTDIR, and `GET /status` answered 500.
      expect(() => deriveSkillManifestInfo(home)).not.toThrow();
      const info = deriveSkillManifestInfo(home);
      expect(info.skillVersion).toBe('1.0.0');
      expect(info.skillCompatible).toBe(true); // nothing assessable is behind
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a well-formed manifest still detects real drift', () => {
    // Floor: the degradation above must not have turned the check off. `mma-audit` is bundled, and
    // the version here is not its bundled one.
    const home = homeWithManifestName('mma-audit');
    try {
      const info = deriveSkillManifestInfo(home);
      expect(info.skillVersion).toBe('1.0.0');
      expect(info.skillCompatible, 'drift detection stopped working').toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
