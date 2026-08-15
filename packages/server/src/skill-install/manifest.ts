/**
 * Install manifest management.
 *
 * The manifest lives at `<homeDir>/.mma/install-manifest.json` and records
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
import matter from 'gray-matter';
import { CLIENT_IDS, type ClientId } from '@zhixuan92/multi-model-agent-core';

/** The `version` a packaged SKILL.md declares in its frontmatter — the value
 *  recorded against every manifest entry, and the one the boot check compares
 *  an installed copy against. `'unknown'` for anything unparseable, so a
 *  malformed skill is recorded as present-but-unversioned rather than dropped. */
export function versionFromContent(content: string): string {
  try {
    const v = matter(content).data['version'];
    return typeof v === 'string' && v.length > 0 ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

const MANIFEST_NAME = 'install-manifest.json';

// ─── Zod schema ──────────────────────────────────────────────────────────────

/** Zod schema for a single client target value — the canonical `ClientId`
 *  vocabulary (`packages/core/src/clients/client-id.ts`), not a
 *  hand-maintained copy. */
const clientIdSchema = z.enum(CLIENT_IDS);

const manifestEntrySchema = z.object({
  name: z.string().min(1),
  skillVersion: z.string().min(1),
  installedAt: z.number().int().nonnegative(),
  targets: z.array(clientIdSchema),
});

const installManifestSchema = z.object({
  version: z.literal(2),
  entries: z.array(manifestEntrySchema),
});

type InstallManifest = z.infer<typeof installManifestSchema>;
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

/** Thrown when the manifest declares a version newer than this mma supports. */
export class FutureManifestError extends Error {
  constructor(version: number) {
    super(`install-manifest.json was written by a newer mma (version ${version}); upgrade mma or remove the file to continue`);
    this.name = 'FutureManifestError';
  }
}

/** Thrown when the manifest JSON parses but fails Zod structural validation. */
class ManifestSchemaValidationError extends Error {
  constructor(manifestPath: string, issues: z.ZodError) {
    super(
      `Manifest file has invalid structure (${manifestPath}): ${issues.message}`,
    );
  }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/** The directory where the manifest file lives. */
function manifestDir(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.mma');
}

/** Full path to the manifest file. */
export function manifestPath(homeDir?: string): string {
  return path.join(manifestDir(homeDir), MANIFEST_NAME);
}

// ─── Low-level I/O ───────────────────────────────────────────────────────────

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
  } catch (err) {
    // Still returns empty — a read that throws would fail daemon boot and every `sync-skills`
    // run over a bookkeeping file. But say so: the file EXISTS (checked above) and could not be
    // read, which means wrong ownership after a sudo install, or a directory in its place. Silent
    // emptiness presents that as "nothing is installed", so sync reinstalls everything on every
    // run and `mma doctor` reports an unknown skill version, indefinitely and without a clue.
    // This was the one branch in this function with no reasoning attached to it.
    process.stderr.write(
      `[mma] install manifest at ${p} exists but could not be read ` +
      `(${(err as NodeJS.ErrnoException).code ?? 'unknown error'}); treating as empty. ` +
      `Skills will be re-provisioned on every sync until it is readable.\n`,
    );
    return emptyManifest();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const backup = backupCorrupted(p);
    process.stderr.write(`[mma] manifest corrupt; rebuilt empty v2 (previous copy at ${backup})\n`);
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

  // v2 — validate strictly, but retire unknown client ids first.
  //
  // WHY THIS STEP EXISTS. `targets` is validated against CLIENT_IDS, which is a
  // living roster: `gemini` became `antigravity` when Google folded Gemini CLI
  // into Antigravity CLI. Without this, every manifest written before such a
  // rename fails validation forever, and because listEntries() throws, skill
  // sync stops for EVERY client on that machine — not just the renamed one —
  // with no message anywhere. A retired client id is stale bookkeeping, not
  // corruption, so it is dropped and reported rather than made fatal.
  //
  // Structural damage still throws. The distinction is deliberate: an entry
  // naming a client that no longer exists is recoverable by re-syncing, while a
  // malformed file is not something to guess at.
  if (parsedVersion === 2) {
    const { cleaned, retired } = dropUnknownTargets(parsed);
    const result = installManifestSchema.safeParse(cleaned);
    if (!result.success) {
      throw new ManifestSchemaValidationError(p, result.error);
    }
    if (retired.length > 0) {
      // Reported, NOT written back. A read that writes is a bad trade twice
      // over: `appendEntry`/`removeEntry` are unlocked read-modify-write
      // operations, so a repair racing one of them silently discards the
      // other's changes; and on a read-only filesystem the write would throw
      // out of what the caller invoked as a read, failing every consumer of
      // listEntries() over a cleanup that was only cosmetic. The cleaned value
      // is returned in memory, so every caller behaves correctly right now, and
      // the next real write persists the cleaned form.
      process.stderr.write(
        `[mma] manifest references ${retired.length} retired client id(s): ${retired.join(', ')}. ` +
        `Ignoring them; run 'mma sync-skills' to rewrite the file.\n`,
      );
    }
    return result.data;
  }

  // Unrecognized shape (or pre-v2 manifest from an older mma) — back up and rebuild empty.
  const backup = backupCorrupted(p);
  process.stderr.write(`[mma] manifest unrecognized; rebuilt empty v2 (previous copy at ${backup})\n`);
  const empty = emptyManifest();
  writeManifest(empty, homeDir);
  return empty;
}

/**
 * Strip target ids that are no longer canonical clients.
 *
 * Touches ONLY the `targets` arrays — every other field is passed through
 * untouched so real structural damage still reaches the validator. An entry
 * left with no targets is dropped: it records an install into a client that no
 * longer exists.
 *
 * @returns the cleaned value and the sorted set of ids that were retired.
 */
function dropUnknownTargets(parsed: unknown): { cleaned: unknown; retired: string[] } {
  const known = new Set<string>(CLIENT_IDS);
  const retired = new Set<string>();
  if (typeof parsed !== 'object' || parsed === null) return { cleaned: parsed, retired: [] };
  const root = parsed as { entries?: unknown };
  if (!Array.isArray(root.entries)) return { cleaned: parsed, retired: [] };

  const entries: unknown[] = [];
  for (const entry of root.entries) {
    if (typeof entry !== 'object' || entry === null) { entries.push(entry); continue; }
    const e = entry as { targets?: unknown };
    if (!Array.isArray(e.targets)) { entries.push(entry); continue; }
    const kept = e.targets.filter((t) => {
      if (typeof t === 'string' && !known.has(t)) { retired.add(t); return false; }
      return true;
    });
    if (kept.length === 0) continue; // installed only into clients that no longer exist
    entries.push({ ...e, targets: kept });
  }
  if (retired.size === 0) return { cleaned: parsed, retired: [] };
  return { cleaned: { ...root, entries }, retired: [...retired].sort() };
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
  newTargets: ClientId[],
  homeDir?: string,
): ManifestEntry {
  const manifest = readManifest(homeDir);

  // De-duplicate incoming targets once, preserving order of first occurrence.
  const seen = new Set<ClientId>();
  const dedupedNewTargets: ClientId[] = newTargets.filter((t) => {
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
  targets: ClientId[] = [],
  homeDir?: string,
): ClientId[] {
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

// ─── Missing-skill detection (relocated from the deleted
// skill-install/skill-installer-common.ts) ─────────────────────────────────

interface MissingSkill {
  name: string;
  targets: ClientId[];
}

/** Every packaged skill in `supportedSkills` that has NO manifest entry yet,
 *  paired with the union of targets already recorded for OTHER skills — the
 *  same clients a fresh skill should be installed to. Returns `[]` when the
 *  manifest is empty (no client has opted in to anything yet). */
export function findMissingSkills(
  manifestEntries: ManifestEntry[],
  supportedSkills: readonly string[],
): MissingSkill[] {
  if (manifestEntries.length === 0) return [];
  const targets = unionTargets(manifestEntries);
  if (targets.length === 0) return [];
  const installedNames = new Set(manifestEntries.map((e) => e.name));
  return supportedSkills
    .filter((name) => !installedNames.has(name))
    .map((name) => ({ name, targets: [...targets] }));
}

function unionTargets(entries: ManifestEntry[]): ClientId[] {
  const seen = new Set<ClientId>();
  const out: ClientId[] = [];
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
