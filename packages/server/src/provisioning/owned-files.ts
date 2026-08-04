/**
 * Ownership-safe skill asset primitives.
 *
 * A skill directory MMA installs (e.g. `~/.claude/skills/mma-audit`) lives inside a
 * root the USER also has full write access to. Before provisioning replaces or
 * removes one, it must be able to PROVE the directory is still exactly what MMA put
 * there — never assume, never overwrite blind. The proof is a marker file,
 * `.mma-install.json`, written alongside the skill's regular files, recording the
 * release that rendered them and a deterministic digest of their bytes:
 *
 *   1. **The marker must be present and its digest must match.** A missing marker
 *      or a digest that no longer matches what the CURRENT render would produce
 *      means the directory was touched by something other than MMA (by hand, by a
 *      different tool, by disk corruption) — refuse rather than clobber it.
 *   2. **A stale release is not a conflict.** If the marker's `release` differs from
 *      the release currently being installed, the directory is still MMA-owned —
 *      just from an earlier install — and safe to replace. There is no way (or need)
 *      to re-render an old release's content just to re-verify its digest; the
 *      marker's own record is trusted for that superseded release.
 *
 * The digest itself is defined byte-exactly so two independent renders of the same
 * release always agree: SHA-256 over the directory's REGULAR FILES ONLY, sorted by
 * POSIX-relative path under byte-wise ordering, each contributing its
 * length-prefixed UTF-8 relative path followed by its length-prefixed raw bytes.
 * Symlinks and directories never enter the map this operates on in the first place,
 * so they never affect the digest. `.mma-install.json` itself is always excluded —
 * it cannot contain a hash of itself.
 */
import { createHash, type Hash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** The marker file every MMA-installed skill directory carries. */
export const SKILL_OWNERSHIP_MARKER_FILE = '.mma-install.json';

/** The parsed shape of `.mma-install.json`. */
export interface SkillOwnershipMarker {
  release: string;
  sha256: string;
}

/**
 * Whether — and how — a skill directory is MMA-owned.
 *
 *  - `unowned`: nothing exists at this path yet. Safe to create fresh.
 *  - `owned`: the marker is present, its recorded release matches the release being
 *    installed, and its digest matches the current render. Safe to replace as a
 *    no-op or identity write.
 *  - `owned-stale`: the marker is present and MMA-authored, but records an earlier
 *    release. Safe to replace (upgrade).
 *  - `modified-conflict`: the directory exists but ownership cannot be proven — the
 *    marker is missing, unparseable, or its digest does not match the render for its
 *    own recorded release. Never replace or delete; preserve and report.
 */
export type SkillOwnershipState = 'unowned' | 'owned' | 'owned-stale' | 'modified-conflict';

export interface SkillOwnershipInspection {
  state: SkillOwnershipState;
  /** The digest computed from the `rendered` files passed in — i.e. what the
   *  CURRENT release would write. Present regardless of state so callers can record
   *  it into a fresh marker after a successful replace. */
  digest: string;
  /** The marker's own fields, when a marker could be read and parsed. Absent for
   *  `unowned` and for a `modified-conflict` caused by a missing/unparseable marker. */
  recordedRelease?: string;
  recordedDigest?: string;
  /** Human-readable detail for `modified-conflict`, suitable for inventory reporting. */
  reason?: string;
}

/** Regular-file bytes keyed by POSIX-relative path. Callers build this by walking a
 *  render (in-memory skill output) or a real directory (via {@link isRegularFile}
 *  filtering) — directories and symlinks are simply never entries in this map. */
export type RenderedFiles = ReadonlyMap<string, Buffer | Uint8Array>;

function toBuffer(bytes: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

/** Compares two relative paths byte-wise over their UTF-8 encoding — not JavaScript's
 *  default UTF-16 code-unit string comparison, which can disagree with byte order
 *  for non-ASCII paths. */
function compareRelativePathsByteWise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function writeLengthPrefixed(hash: Hash, bytes: Buffer): void {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  hash.update(length);
  hash.update(bytes);
}

/**
 * The canonical digest of a rendered skill directory's regular files.
 *
 * Deterministic across processes and platforms: sorted by byte-wise POSIX-relative
 * path, each entry contributing `length-prefixed path + length-prefixed bytes` to a
 * single SHA-256. `.mma-install.json` is always excluded, even if present in `files`.
 */
export function computeSkillDigest(files: RenderedFiles): string {
  const hash = createHash('sha256');
  const paths = [...files.keys()]
    .filter((relativePath) => relativePath !== SKILL_OWNERSHIP_MARKER_FILE)
    .sort(compareRelativePathsByteWise);
  for (const relativePath of paths) {
    const bytes = files.get(relativePath);
    if (bytes === undefined) continue;
    writeLengthPrefixed(hash, Buffer.from(relativePath, 'utf8'));
    writeLengthPrefixed(hash, toBuffer(bytes));
  }
  return hash.digest('hex');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses `.mma-install.json` bytes, returning `undefined` for any shape that is not
 *  exactly `{ release: string, sha256: string }` — an unparseable or malformed marker
 *  proves nothing, so it is treated identically to a missing one. */
function parseSkillOwnershipMarker(bytes: Buffer): SkillOwnershipMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed)) return undefined;
  const { release, sha256 } = parsed;
  if (typeof release !== 'string' || typeof sha256 !== 'string') return undefined;
  return { release, sha256 };
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await lstat(dir)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Read only the directory's regular files. `lstat` deliberately excludes
 * symlinks (including links to regular files) and the marker from the ownership
 * proof, exactly as the digest contract requires. Exported so callers that need
 * the SAME regular-file set this module's own ownership proof uses -- e.g. a
 * provisioning backup snapshot's digest -- never re-implement directory
 * walking (and risk disagreeing with it) themselves. */
export async function readInstalledRegularFiles(root: string, current = root): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const name of await readdir(current)) {
    const absolutePath = join(current, name);
    const metadata = await lstat(absolutePath);
    if (metadata.isDirectory()) {
      for (const [relativePath, bytes] of await readInstalledRegularFiles(root, absolutePath)) {
        files.set(relativePath, bytes);
      }
      continue;
    }
    if (!metadata.isFile()) continue;

    const relativePath = relative(root, absolutePath).split(sep).join('/');
    if (relativePath !== SKILL_OWNERSHIP_MARKER_FILE) {
      files.set(relativePath, await readFile(absolutePath));
    }
  }
  return files;
}

/**
 * Inspect whether `dir` is MMA-owned for the given `installedRelease`, against the
 * current render `rendered` (what that release's skill content actually is).
 *
 * Never mutates the filesystem — this is the read-only proof step callers gate a
 * replace/remove decision on.
 */
export async function inspectSkillOwnership(
  dir: string,
  rendered: RenderedFiles,
  installedRelease: string,
): Promise<SkillOwnershipInspection> {
  const digest = computeSkillDigest(rendered);

  if (!(await directoryExists(dir))) {
    return { state: 'unowned', digest };
  }

  const markerPath = join(dir, SKILL_OWNERSHIP_MARKER_FILE);
  let markerBytes: Buffer;
  try {
    markerBytes = await readFile(markerPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return {
      state: 'modified-conflict',
      digest,
      reason: `${markerPath} is missing — ownership of ${dir} cannot be proven, so it is left untouched.`,
    };
  }

  const marker = parseSkillOwnershipMarker(markerBytes);
  if (marker === undefined) {
    return {
      state: 'modified-conflict',
      digest,
      reason: `${markerPath} is not a valid ownership marker ({ release: string, sha256: string }) — ownership of ${dir} cannot be proven, so it is left untouched.`,
    };
  }

  if (marker.release !== installedRelease) {
    // MMA-owned, just from an earlier install. Its own digest cannot be re-verified
    // here — that would require re-rendering the OLD release, which this function
    // has no way to do — so the marker's record is trusted for its own release.
    return { state: 'owned-stale', digest, recordedRelease: marker.release, recordedDigest: marker.sha256 };
  }

  const installedFiles = await readInstalledRegularFiles(dir);
  const installedDigest = computeSkillDigest(installedFiles);
  // An otherwise empty marker directory is a recoverable interrupted install: it
  // contains no user regular-file content to preserve, and the matching marker
  // still proves MMA created it. Any installed regular file must match the render.
  if (marker.sha256 !== digest || (installedFiles.size > 0 && installedDigest !== digest)) {
    return {
      state: 'modified-conflict',
      digest,
      recordedRelease: marker.release,
      recordedDigest: marker.sha256,
      reason: `${dir} does not match the digest recorded for release ${marker.release} — its contents were modified outside MMA, so it is left untouched.`,
    };
  }

  return { state: 'owned', digest, recordedRelease: marker.release, recordedDigest: marker.sha256 };
}
