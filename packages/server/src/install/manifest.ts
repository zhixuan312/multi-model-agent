/**
 * Install manifest management.
 *
 * The manifest lives at `<homeDir>/.multi-model/install-manifest.json` and records
 * every skill ever installed so `install-skill --uninstall` can reverse
 * the operation without leaving orphaned files.
 *
 * All functions accept an optional `homeDir` parameter for testability.
 * When omitted, `os.homedir()` is used as the default.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

/** Union of all supported AI client targets. */
export type Client = 'claude-code' | 'gemini' | 'codex' | 'cursor';

/** All known client values — used for --all-targets and target validation. */
export const ALL_CLIENTS: readonly Client[] = ['claude-code', 'gemini', 'codex', 'cursor'];

/**
 * Detect which AI client directories exist in the home directory.
 * Checks for evidence of each known client:
 * - claude-code: ~/.claude/ directory present (installs skills under ~/.claude/skills/)
 * - gemini:       ~/.gemini/extensions/ directory present
 * - codex:        ~/.codex/AGENTS.md file present
 * - cursor:       ~/.cursor/rules/ directory present
 *
 * The claude-code check deliberately accepts ~/.claude/ as sufficient signal
 * even when ~/.claude/skills/ does not yet exist (fresh install with no skills).
 */
export function detectClients(homeDir: string): Client[] {
  const detected: Client[] = [];
  if (fs.existsSync(path.join(homeDir, '.claude'))) detected.push('claude-code');
  if (fs.existsSync(path.join(homeDir, '.gemini', 'extensions'))) detected.push('gemini');
  if (fs.existsSync(path.join(homeDir, '.codex', 'AGENTS.md'))) detected.push('codex');
  if (fs.existsSync(path.join(homeDir, '.cursor', 'rules'))) detected.push('cursor');
  return detected;
}

const MANIFEST_NAME = 'install-manifest.json';

// ─── Zod schema ──────────────────────────────────────────────────────────────

/** Zod schema for a single client target value. */
const clientSchema = z.enum(['claude-code', 'gemini', 'codex', 'cursor']);
type ClientValue = z.infer<typeof clientSchema>;

const manifestEntrySchema = z.object({
  name: z.string().min(1),
  skillVersion: z.string().min(1),
  installedAt: z.number().int().nonnegative(),
  targets: z.array(clientSchema),
});

const installManifestSchema = z.object({
  version: z.literal(2),
  entries: z.array(manifestEntrySchema),
});

export type InstallManifest = z.infer<typeof installManifestSchema>;
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

/** Thrown when the manifest declares a version newer than this mmagent supports. */
export class FutureManifestError extends Error {
  constructor(version: number) {
    super(`install-manifest.json was written by a newer mmagent (version ${version}); upgrade mmagent or remove the file to continue`);
    this.name = 'FutureManifestError';
  }
}

/** Thrown when the manifest file exists but cannot be parsed as valid JSON. */
export class ManifestParseError extends Error {
  constructor(manifestPath: string, cause: string) {
    super(`Manifest file is corrupt (${manifestPath}): ${cause}`);
  }
}

/** Thrown when the manifest JSON parses but fails Zod structural validation. */
export class ManifestSchemaValidationError extends Error {
  constructor(manifestPath: string, issues: z.ZodError) {
    super(
      `Manifest file has invalid structure (${manifestPath}): ${issues.message}`,
    );
  }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/** The directory where the manifest file lives. */
export function manifestDir(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.multi-model');
}

/** Full path to the manifest file. */
export function manifestPath(homeDir?: string): string {
  return path.join(manifestDir(homeDir), MANIFEST_NAME);
}

// ─── Low-level I/O ───────────────────────────────────────────────────────────

interface V1Entry {
  name: string;
  version: string;
  installedAt: number;
  targets: ClientValue[];
}

function backupCorrupted(p: string): string {
  const backup = `${p}.bak-${Date.now()}`;
  try { fs.renameSync(p, backup); } catch { /* ignore — best effort */ }
  return backup;
}

function readManifest(homeDir?: string): InstallManifest {
  const p = manifestPath(homeDir);
  if (!fs.existsSync(p)) return emptyManifest();

  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    return emptyManifest();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const backup = backupCorrupted(p);
    process.stderr.write(`[mmagent] manifest corrupt; rebuilt empty v2 (previous copy at ${backup})\n`);
    const empty = emptyManifest();
    writeManifest(empty, homeDir);
    return empty;
  }

  const parsedVersion =
    parsed !== null && typeof parsed === 'object' && 'version' in parsed
      ? (parsed as { version: unknown }).version
      : undefined;

  if (typeof parsedVersion === 'number' && parsedVersion > 2) {
    throw new FutureManifestError(parsedVersion);
  }

  // v2 — validate strictly
  if (parsedVersion === 2) {
    const result = installManifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new ManifestSchemaValidationError(p, result.error);
    }
    return result.data;
  }

  // v1 (legacy) — migrate to v2.
  // v1 entries have `version` (skill version) instead of `skillVersion`.
  if (
    parsedVersion === 1 ||
    (parsedVersion === undefined && parsed !== null && typeof parsed === 'object' && 'entries' in parsed)
  ) {
    const v1Entries = Array.isArray((parsed as { entries?: unknown }).entries)
      ? ((parsed as { entries: unknown[] }).entries as V1Entry[])
      : [];
    const migrated: InstallManifest = {
      version: 2,
      entries: v1Entries
        .filter((e) => e && typeof e === 'object' && typeof e.name === 'string')
        .map((e) => ({
          name: e.name,
          skillVersion: typeof e.version === 'string' && e.version.length > 0 ? e.version : 'unknown',
          installedAt: typeof e.installedAt === 'number' ? e.installedAt : 0,
          targets: Array.isArray(e.targets)
            ? e.targets.filter((t): t is ClientValue => (['claude-code', 'gemini', 'codex', 'cursor'] as const).includes(t as ClientValue))
            : [],
        })),
    };
    // Persist the migration so subsequent reads skip it.
    writeManifest(migrated, homeDir);
    process.stderr.write(`[mmagent] install-manifest.json migrated v1 → v2\n`);
    return migrated;
  }

  // Unknown shape — back up and rebuild empty.
  const backup = backupCorrupted(p);
  process.stderr.write(`[mmagent] manifest unrecognized; rebuilt empty v2 (previous copy at ${backup})\n`);
  const empty = emptyManifest();
  writeManifest(empty, homeDir);
  return empty;
}

function writeManifest(manifest: InstallManifest, homeDir?: string): void {
  fs.mkdirSync(manifestDir(homeDir), { recursive: true, mode: 0o700 });
  fs.writeFileSync(manifestPath(homeDir), JSON.stringify(manifest, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

function emptyManifest(): InstallManifest {
  return { version: 2, entries: [] };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Return all manifest entries, newest-first.
 */
export function listEntries(homeDir?: string): ManifestEntry[] {
  return readManifest(homeDir).entries;
}

/**
 * Find the entry for `skillName`, or undefined if not installed.
 */
export function getEntry(skillName: string, homeDir?: string): ManifestEntry | undefined {
  return readManifest(homeDir).entries.find((e) => e.name === skillName);
}

/**
 * Append (or update) the entry for `skillName`.
 *
 * - New entry: creates with de-duplicated `newTargets`.
 * - Existing entry: merges `newTargets` into existing targets (no duplicates),
 *   refreshes `version` and `installedAt`.
 *
 * In both paths the stored `targets` array is a fresh copy — caller mutations
 * after the call do not affect the in-memory object or persisted manifest.
 *
 * Returns the resulting entry.
 */
export function appendEntry(
  skillName: string,
  skillVersion: string,
  newTargets: Client[],
  homeDir?: string,
): ManifestEntry {
  const manifest = readManifest(homeDir);

  // De-duplicate incoming targets once, preserving order of first occurrence.
  const seen = new Set<Client>();
  const dedupedNewTargets: Client[] = newTargets.filter((t) => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });

  const existing = manifest.entries.find((e) => e.name === skillName);

  if (existing) {
    for (const t of dedupedNewTargets) {
      if (!existing.targets.includes(t)) existing.targets.push(t);
    }
    existing.skillVersion = skillVersion;
    existing.installedAt = Date.now();
  } else {
    // Clone the array so the caller cannot mutate the stored entry.
    manifest.entries.push({
      name: skillName,
      skillVersion,
      installedAt: Date.now(),
      targets: [...dedupedNewTargets],
    });
  }

  writeManifest(manifest, homeDir);
  return existing ?? manifest.entries[manifest.entries.length - 1]!;
}

/**
 * Remove `targets` from the entry for `skillName`.
 * If `targets` is omitted or empty, removes the entire entry.
 * Returns the removed targets (or all targets for a full removal),
 * or an empty array if the skill wasn't in the manifest.
 */
export function removeEntry(
  skillName: string,
  targets: Client[] = [],
  homeDir?: string,
): Client[] {
  const manifest = readManifest(homeDir);
  const idx = manifest.entries.findIndex((e) => e.name === skillName);
  if (idx === -1) return [];

  const entry = manifest.entries[idx]!;

  if (targets.length === 0) {
    // Full removal
    manifest.entries.splice(idx, 1);
    writeManifest(manifest, homeDir);
    return [...entry.targets];
  }

  // Partial removal: only remove specified targets
  const removed = entry.targets.filter((t) => targets.includes(t));
  entry.targets = entry.targets.filter((t) => !removed.includes(t));
  if (entry.targets.length === 0) {
    manifest.entries.splice(idx, 1);
  }
  writeManifest(manifest, homeDir);
  return removed;
}

/**
 * Returns true when `skillName` is recorded in the manifest with at least one target.
 */
export function isInstalled(skillName: string, homeDir?: string): boolean {
  const e = getEntry(skillName, homeDir);
  return e !== undefined && e.targets.length > 0;
}