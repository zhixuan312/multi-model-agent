// Runner-agnostic skill resolution + staging for the /delegate route.
// Resolves skill names against the main agent's store (selected by the
// X-MMA-Client value) and copies each into an ephemeral per-task staging
// root. Each worker Session adapts that root to its runtime: Claude wraps
// it as a local plugin; Codex points $CODEX_HOME at it. Real user stores
// are read-only here — staging is copy-out only.

import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cp, mkdir, rm, stat, chmod, readdir } from 'node:fs/promises';
import type { ResolvedSkillBundle } from '../types/run-result.js';

export type SkillErrorCode =
  | 'skill_not_found'
  | 'skill_store_unsupported'
  | 'skill_staging_failed'
  | 'skill_payload_too_large'
  | 'skill_isolation_unsupported';

export class SkillResolutionError extends Error {
  constructor(public readonly code: SkillErrorCode, message: string) {
    super(message);
    this.name = 'SkillResolutionError';
  }
}

const MAX_SKILLS = 20;
const MAX_BYTES = 25 * 1024 * 1024; // 26214400

/** Per-client default skill-store directory. Out-of-list clients are unsupported. */
function storeDirForClient(client: string): string {
  switch (client) {
    case 'claude-code': return join(homedir(), '.claude', 'skills');
    case 'codex-cli': return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'skills');
    default:
      throw new SkillResolutionError(
        'skill_store_unsupported',
        `no skills store configured for client '${client}'`,
      );
  }
}

/** Resolve a skill name to a source directory in the store.
 *  Bare names are looked up directly under the store: "foo" → "<store>/foo".
 *  The "plugin:skill" form is not yet supported; plugin skills live under
 *  ~/.claude/plugins but require separate resolution logic not implemented
 *  in this iteration. Reject any colon-containing names explicitly. */
function candidateDir(storeDir: string, name: string): string {
  if (name.includes(':')) {
    throw new SkillResolutionError(
      'skill_not_found',
      `plugin:skill form '${name}' not yet supported (plugin skills require separate resolution)`,
    );
  }
  return join(storeDir, name);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else if (entry.isFile()) total += (await stat(p)).size;
  }
  return total;
}

async function restrictPermissions(path: string): Promise<void> {
  const s = await stat(path);
  if (s.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      await restrictPermissions(join(path, entry.name));
    }
  } else if (s.isFile()) {
    await chmod(path, 0o600);
  }
}

export interface ResolveStageInput {
  client: string;
  names: string[];
  batchId: string;
  taskIndex: number;
  /** Test-only: override the resolved store directory. */
  storeDirOverride?: string;
}

export async function resolveAndStageSkills(input: ResolveStageInput): Promise<ResolvedSkillBundle> {
  const { client, names, batchId, taskIndex, storeDirOverride } = input;

  if (process.platform === 'win32') {
    throw new SkillResolutionError(
      'skill_isolation_unsupported',
      'skill passthrough requires owner-only filesystem permissions not enforceable on win32',
    );
  }
  if (names.length > MAX_SKILLS) {
    throw new SkillResolutionError(
      'skill_payload_too_large',
      `skillCount=${names.length} exceeds maxSkills=${MAX_SKILLS} (maxBytes=${MAX_BYTES})`,
    );
  }

  const storeDir = storeDirOverride ?? storeDirForClient(client);

  // Resolve every source dir first (fail fast before any copy).
  const sources: Array<{ name: string; dir: string }> = [];
  for (const name of names) {
    const dir = candidateDir(storeDir, name);
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) throw new Error('not a directory');
    } catch {
      throw new SkillResolutionError('skill_not_found', `skill '${name}' not in ${storeDir}`);
    }
    sources.push({ name, dir });
  }

  // Enforce byte budget across all sources.
  let totalBytes = 0;
  for (const s of sources) totalBytes += await dirSize(s.dir);
  if (totalBytes > MAX_BYTES) {
    throw new SkillResolutionError(
      'skill_payload_too_large',
      `totalBytes=${totalBytes} exceeds maxBytes=${MAX_BYTES} (skillCount=${names.length}, maxSkills=${MAX_SKILLS})`,
    );
  }

  const stagedRoot = join(tmpdir(), 'mma-skills', batchId, String(taskIndex));
  const skillsDir = join(stagedRoot, 'skills');
  try {
    await mkdir(skillsDir, { recursive: true, mode: 0o700 });
    await chmod(stagedRoot, 0o700);
    for (const s of sources) {
      const dest = join(skillsDir, s.name);
      await cp(s.dir, dest, { recursive: true });
      await restrictPermissions(dest);
    }
  } catch (err) {
    await cleanupSkillStaging(stagedRoot);
    if (err instanceof SkillResolutionError) throw err;
    throw new SkillResolutionError(
      'skill_staging_failed',
      `copy failed staging into ${skillsDir}: ${(err as Error).message}`,
    );
  }

  return { stagedRoot, names: sources.map((s) => s.name) };
}

export async function cleanupSkillStaging(stagedRoot: string): Promise<void> {
  await rm(stagedRoot, { recursive: true, force: true }).catch(() => { /* best-effort */ });
  // Prune the now-empty batch dir if no sibling task subdirs remain.
  const batchDir = join(stagedRoot, '..');
  try {
    const left = await readdir(batchDir);
    if (left.length === 0) await rm(batchDir, { recursive: true, force: true });
  } catch { /* batch dir already gone */ }
}
