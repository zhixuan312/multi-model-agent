import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));

function resolveSkillsDir(): string {
  // Dev (monorepo): packages/server/src/application/ → packages/core/src/skills/
  const devPath = path.resolve(thisDir, '..', '..', '..', '..', 'packages', 'core', 'src', 'skills');
  if (fs.existsSync(devPath)) return devPath;
  // Production (global install): server package root → node_modules/@zhixuan92/multi-model-agent-core/src/skills/
  const serverRoot = path.resolve(thisDir, '..', '..');
  const prodPath = path.join(serverRoot, 'node_modules', '@zhixuan92', 'multi-model-agent-core', 'src', 'skills');
  if (fs.existsSync(prodPath)) return prodPath;
  return devPath;
}

/** Resolved once at module load — the per-type skill markdown root. */
export const SKILLS_DIR = resolveSkillsDir();
