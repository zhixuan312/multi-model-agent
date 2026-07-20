import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_SKILLS, readSkillContent } from './discover.js';
import type { Client } from './manifest.js';
import matter from 'gray-matter';

export interface DriftEntry {
  skill: string;
  client: Client;
  issue: 'missing' | 'outdated' | 'orphan';
}

export interface SkillManifestSync {
  driftReport(): DriftEntry[];
}

function canonicalVersion(skillName: string): string | null {
  const content = readSkillContent(skillName);
  if (content === null) return null;
  try {
    const parsed = matter(content);
    const v = parsed.data['version'];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function makeSkillManifestSync(
  perClientInstallDirs: Partial<Record<Client, string>>,
  disabled: readonly Client[] = [],
): SkillManifestSync {
  const disabledSet = new Set<Client>(disabled);
  return {
    driftReport(): DriftEntry[] {
      const drift: DriftEntry[] = [];
      const supported = new Set<string>(SUPPORTED_SKILLS);
      for (const [client, dir] of Object.entries(perClientInstallDirs)) {
        // Skip clients the user deliberately disabled (`mma disable --target=X`);
        // their skills are intentionally absent, not drift.
        if (disabledSet.has(client as Client)) continue;
        let entries: string[];
        try { entries = readdirSync(dir); } catch { continue; }
        const present = new Set(
          entries.filter(n => n.startsWith('mma-') || n === 'multi-model-agent'),
        );
        for (const exp of supported) {
          if (!present.has(exp)) drift.push({ skill: exp, client: client as Client, issue: 'missing' });
        }
        for (const got of present) {
          if (!supported.has(got)) {
            drift.push({ skill: got, client: client as Client, issue: 'orphan' });
          }
        }
        for (const skill of present) {
          if (!supported.has(skill)) continue;
          const canonVer = canonicalVersion(skill);
          if (canonVer === null) continue;
          const installedPath = join(dir, skill, 'SKILL.md');
          try {
            const installedContent = readFileSync(installedPath, 'utf-8');
            const parsed = matter(installedContent);
            const installedVer = parsed.data['version'];
            if (typeof installedVer === 'string' && installedVer !== canonVer) {
              drift.push({ skill, client: client as Client, issue: 'outdated' });
            }
          } catch {
            // skip outdated check if installed SKILL.md is unreadable
          }
        }
      }
      return drift;
    },
  };
}
