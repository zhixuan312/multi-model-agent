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
 * false when the skill was removed from the bundle (sync-skills drops it) or the
 * bundled frontmatter can't be parsed.
 */
export function isSkillBehind(entryName: string, entrySkillVersion: string): boolean {
  const src = readSkillContent(entryName);
  if (src === null) return false; // skill removed from bundle — sync-skills will drop it
  try {
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
export function deriveSkillManifestInfo(homeDir?: string): SkillManifestInfo {
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
  const skillCompatible = !entries.some((e) => isSkillBehind(e.name, e.skillVersion));
  return { skillVersion, skillCompatible };
}
