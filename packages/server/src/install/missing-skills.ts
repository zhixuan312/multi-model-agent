import type { ManifestEntry, Client } from './manifest.js';

export interface MissingSkill {
  name: string;
  targets: Client[];
}

/**
 * Skills present in `supportedSkills` but not in `manifestEntries`. The
 * `targets` for each missing skill is the union of all targets currently
 * in the manifest, preserving first-seen order. Returns [] when the
 * manifest is empty (the user never opted in to any mma skills).
 */
export function findMissingSkills(
  manifestEntries: ManifestEntry[],
  supportedSkills: readonly string[],
): MissingSkill[] {
  if (manifestEntries.length === 0) return [];
  const targets = unionTargets(manifestEntries);
  // If every entry has empty targets (corrupt or never-completed install),
  // treat as no opted-in clients — same as an empty manifest.
  if (targets.length === 0) return [];
  const installedNames = new Set(manifestEntries.map((e) => e.name));
  return supportedSkills
    .filter((name) => !installedNames.has(name))
    .map((name) => ({ name, targets: [...targets] }));  // defensive copy per skill
}

/**
 * Skills present in the manifest but NOT in `supportedSkills`. These are
 * orphaned — previously installed but no longer shipped. The `targets`
 * for each orphan is the entry's recorded targets (so the caller knows
 * which client dirs to clean).
 */
export function findOrphanedSkills(
  manifestEntries: ManifestEntry[],
  supportedSkills: readonly string[],
): ManifestEntry[] {
  return manifestEntries.filter((e) => !supportedSkills.includes(e.name));
}

function unionTargets(entries: ManifestEntry[]): Client[] {
  const seen = new Set<Client>();
  const out: Client[] = [];
  for (const e of entries) {
    for (const t of e.targets) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}
