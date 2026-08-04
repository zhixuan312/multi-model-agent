/**
 * Recording what a provisioning run installed into `~/.mma/install-manifest.json`.
 *
 * Two records exist and they answer different questions, which is why neither
 * replaces the other:
 *
 *  - A skill directory's `.mma-install.json` (see `provisioning/owned-files.ts`)
 *    answers "may MMA replace or delete THIS directory?" — a per-directory
 *    ownership proof, read only at the moment of a mutation.
 *  - The install manifest answers "which skill versions are installed, for which
 *    clients?" across every client at once. That is what `cli/serve.ts`'s boot
 *    check and `skill-install/skill-drift.ts` need, and answering it from the
 *    ownership markers would mean walking every client's skill root on every
 *    daemon start.
 *
 * This module exists so the manifest is written in ONE place. Both provisioning
 * entry points reach it — `mma sync-skills` and `mma mcp install <ClientId>` —
 * and a second entry point that provisioned skills without recording them would
 * leave the boot check blind to them: `findMissingSkills` returns nothing at all
 * for an empty manifest, so those skills would never be seen as behind on a later
 * upgrade.
 */
import path from 'node:path';
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import { appendEntry, versionFromContent } from './manifest.js';
import { readSkillContent, SUPPORTED_SKILLS } from './discover.js';

interface RecordProvisionedFailure {
  clientId: ClientId;
  reason: string;
}

/**
 * Record every packaged skill against each client that was ACTUALLY provisioned
 * — never a client that was merely requested, skipped, or failed.
 *
 * Returns the packaged skills it could not read, so the caller can surface them
 * the way its own outcome shape expects rather than this module inventing one.
 */
export function recordProvisionedSkills(
  provisioned: readonly ClientId[],
  skillsRoot: string,
  homeDir?: string,
): RecordProvisionedFailure[] {
  if (provisioned.length === 0) return [];
  const failures: RecordProvisionedFailure[] = [];
  for (const skillName of SUPPORTED_SKILLS) {
    const content = readSkillContent(skillName, skillsRoot);
    if (content === null) {
      failures.push({
        clientId: provisioned[0]!,
        reason: `Bundled SKILL.md not found for '${skillName}' at ${path.join(skillsRoot, skillName, 'SKILL.md')}`,
      });
      continue;
    }
    const canonicalVersion = versionFromContent(content);
    for (const clientId of provisioned) {
      appendEntry(skillName, canonicalVersion, [clientId], homeDir);
    }
  }
  return failures;
}
