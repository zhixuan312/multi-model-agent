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
  version: z.string().min(1),
  installedAt: z.number().int().nonnegative(),
  targets: z.array(clientSchema),
});

const installManifestSchema = z.object({
  version: z.number().int().nonnegative(),
  entries: z.array(manifestEntrySchema),
});

export type InstallManifest = z.infer<typeof installManifestSchema>;
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

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

function readManifest(homeDir?: string): InstallManifest {
  const p = manifestPath(homeDir);
  if (!fs.existsSync(p)) return emptyManifest();
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    // Validate structure with Zod so corrupt-but-valid-JSON is caught at load
    // rather than failing in unpredictable ways downstream.
    const result = installManifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new ManifestSchemaValidationError(p, result.error);
    }
    return result.data;
  } catch (err) {
    if (err instanceof ManifestSchemaValidationError) throw err;
    const detail =
      err instanceof SyntaxError
        ? `JSON parse error: ${err.message}`
        : err instanceof Error ? err.message : String(err);
    throw new ManifestParseError(p, detail);
  }
}

function writeManifest(manifest: InstallManifest, homeDir?: string): void {
  fs.mkdirSync(manifestDir(homeDir), { recursive: true, mode: 0o700 });
  fs.writeFileSync(manifestPath(homeDir), JSON.stringify(manifest, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

function emptyManifest(): InstallManifest {
  return { version: 1, entries: [] };
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
  version: string,
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
    existing.version = version;
    existing.installedAt = Date.now();
  } else {
    // Clone the array so the caller cannot mutate the stored entry.
    manifest.entries.push({
      name: skillName,
      version,
      installedAt: Date.now(),
      targets: [...dedupedNewTargets],
    });
  }

  writeManifest(manifest, homeDir);
  return existing ?? manifest.entries[manifest.entries.length - 1];
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

  const entry = manifest.entries[idx];

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