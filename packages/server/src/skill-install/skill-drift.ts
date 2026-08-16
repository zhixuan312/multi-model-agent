// skill-drift.ts — the single source of truth for "is an installed skill out of
// date relative to the bundled skill this server ships?".
//
// Both serve-startup drift warnings (cli/serve.ts) and the GET /status operator
// endpoint (http/handlers/introspection/status.ts) consume this. It reads the
// REAL install manifest (install-manifest.json via listEntries) and compares each
// installed skill's version against the bundled SKILL.md frontmatter — there is no
// separate manifest file and no hardcoded compatible-major range.
import matter from 'gray-matter';
import { listEntries } from './manifest.js';
import { readSkillContent } from './discover.js';

/**
 * True when the bundled SKILL.md declares a version different from the one
 * recorded for this installed skill — i.e. the on-disk skill is stale. Returns
 * false whenever the question cannot be answered: the skill was removed from the
 * bundle (sync-skills drops it), the bundled frontmatter can't be parsed, or the
 * bundled file can't be read at all.
 *
 * That last case is why the read is INSIDE the try. `readSkillContent` propagates
 * every non-ENOENT I/O error by design, and all three callers here are best-effort
 * reporters that must not fail on it: `cli/serve.ts` runs this at boot behind a
 * guard commented "never let manifest IO issues block serve" (its filter sat
 * outside that guard, so an EACCES on one bundled file stopped the daemon from
 * starting), `cli/doctor.ts` runs it to REPORT on a broken install, and
 * `deriveSkillManifestInfo` below promises never to throw. "Cannot assess" is not
 * "behind", and it is certainly not "crash".
 */
export function isSkillBehind(
  entryName: string,
  entrySkillVersion: string,
  skillsRoot?: string,
): boolean {
  try {
    const src = readSkillContent(entryName, skillsRoot);
    if (src === null) return false; // skill removed from bundle — sync-skills will drop it
    const parsed = matter(src);
    const v = parsed.data['version'];
    return typeof v === 'string' && v !== entrySkillVersion;
  } catch {
    return false;
  }
}

interface SkillManifestInfo {
  /** The installed skill version (uniform across entries at install time), or null. */
  skillVersion: string | null;
  /** Null when nothing is installed; else true iff no installed skill is behind the bundle. */
  skillCompatible: boolean | null;
}

/**
 * Derive the skill-version / compatibility summary reported by GET /status from
 * the real install manifest. Never throws — a future/corrupt manifest degrades to
 * the "unknown" ({ null, null }) shape rather than failing the status response.
 */
export function deriveSkillManifestInfo(homeDir?: string, skillsRoot?: string): SkillManifestInfo {
  let entries;
  try {
    entries = listEntries(homeDir);
  } catch {
    // Every failure means the same thing HERE: the manifest cannot be assessed, so report
    // "unknown" rather than fail the status response. An `if (err instanceof FutureManifestError)`
    // used to precede this, returning the identical value — a branch that could not change the
    // outcome, on a distinction that matters to the callers who ACT on it (`cli/doctor.ts` names
    // it in its detail line, `cli/sync-skills.ts` exits 2 on it, `cli/serve.ts` warns) and not to
    // this one, which only reports.
    return { skillVersion: null, skillCompatible: null };
  }

  if (entries.length === 0) return { skillVersion: null, skillCompatible: null };

  const skillVersion = entries[0]!.skillVersion;
  const skillCompatible = !entries.some((e) => isSkillBehind(e.name, e.skillVersion, skillsRoot));
  return { skillVersion, skillCompatible };
}
