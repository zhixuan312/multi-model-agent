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
 *   2. **A stale release is still verified, just against a different yardstick.**
 *      If the marker's `release` differs from the release currently being installed,
 *      the old release's bytes cannot be re-rendered here — but the marker recorded
 *      THEIR digest, so the directory can still be correlated against its own
 *      record. Content matching that record is MMA-owned from an earlier install and
 *      safe to replace; content that does not is a conflict exactly like any other.
 *      The marker sits in a directory the user can also write, so "the marker says
 *      so" is never a proof on its own.
 *   3. **Every entry must be a regular file or a directory.** A symlink (or socket,
 *      or device) at a path the render expects to be a file cannot be proven owned,
 *      and following it would let a write escape the skill directory entirely —
 *      so its presence is a conflict, never something quietly skipped.
 *
 * The digest itself is defined byte-exactly so two independent renders of the same
 * release always agree: SHA-256 over the directory's REGULAR FILES ONLY, sorted by
 * POSIX-relative path under byte-wise ordering, each contributing its
 * length-prefixed UTF-8 relative path followed by its length-prefixed raw bytes.
 * Directories contribute nothing themselves (only the files beneath them), and a
 * non-regular entry aborts the walk rather than being excluded from it.
 * `.mma-install.json` itself is always excluded — it cannot contain a hash of itself.
 */
import { createHash, type Hash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** The marker file every MMA-installed skill directory carries. */
export const SKILL_OWNERSHIP_MARKER_FILE = '.mma-install.json';

/**
 * Thrown when a skill directory holds an entry that is neither a regular file nor
 * a directory — a symlink above all.
 *
 * Skipping such an entry (the obvious alternative) is precisely what makes it
 * dangerous: an excluded entry contributes nothing to the digest, so a directory
 * whose only file was swapped for a symlink still hashes to whatever the marker
 * records, passes as owned, and is then written through — truncating the symlink's
 * target somewhere else on disk entirely. Ownership must be unprovable here, not
 * merely unaffected.
 */
export class UnprovableSkillEntryError extends Error {
  readonly code = 'unprovable_skill_entry' as const;
  readonly path: string;

  constructor(path: string) {
    super(
      `${path} is not a regular file or directory (it may be a symlink) — MMA cannot prove it owns this content, `
      + 'so the directory is left untouched.',
    );
    this.name = 'UnprovableSkillEntryError';
    this.path = path;
  }
}

/** The parsed shape of `.mma-install.json`. */
interface SkillOwnershipMarker {
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
 *  - `owned-stale`: the marker records an earlier release AND the directory's
 *    contents still match the digest that install recorded. Safe to replace (upgrade).
 *  - `modified-conflict`: the directory exists but ownership cannot be proven — the
 *    marker is missing, unparseable, or its digest does not match the directory's
 *    actual contents; or the directory holds an entry that is neither a regular file
 *    nor a directory. Never replace or delete; preserve and report.
 */
type SkillOwnershipState = 'unowned' | 'owned' | 'owned-stale' | 'modified-conflict';

interface SkillOwnershipInspection {
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

/**
 * What is at `dir` right now: nothing, a real directory, or something else.
 *
 * The three-way answer is the point. Collapsing "something else" into "nothing"
 * is how a symlinked skill DIRECTORY became indistinguishable from a fresh
 * install: `lstat` on a symlink never reports `isDirectory()` even when it points
 * at one, so a boolean check reads it as absent, ownership comes back `unowned`,
 * and installation happily creates files "fresh" — inside whatever directory the
 * link points at. Nothing here is a directory-component-aware write; the guard has
 * to be the classification itself.
 */
async function classifyDirEntry(dir: string): Promise<'absent' | 'directory' | 'other'> {
  try {
    return (await lstat(dir)).isDirectory() ? 'directory' : 'other';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
}

/** Read the directory's regular files, throwing {@link UnprovableSkillEntryError}
 * for any entry that is neither a regular file nor a directory. `lstat` (never
 * `stat`) is what makes that distinction possible: a symlink must be recognised as
 * a symlink, not silently resolved to whatever it points at. The marker is excluded
 * from the returned set because it cannot contain a hash of itself. Exported so
 * callers that need the SAME regular-file set this module's own ownership proof
 * uses -- e.g. a provisioning backup snapshot's digest -- never re-implement
 * directory walking (and risk disagreeing with it) themselves. */
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
    if (!metadata.isFile()) throw new UnprovableSkillEntryError(absolutePath);

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
  return inspect(dir, computeSkillDigest(rendered), installedRelease);
}

/**
 * Inspect a directory whose skill this release no longer ships at all — a skill
 * retired between versions, still sitting in the user's skill root.
 *
 * There is no render to compare against, and there never will be again, so the
 * ONLY available proof is the one the marker already carries: an install recorded
 * its own digest, and content still matching that record was put there by MMA and
 * has not been touched since. That is exactly the rule {@link
 * inspectSkillOwnership} already applies to a superseded release, so this is the
 * same check with the render step removed rather than a second ownership notion.
 *
 * Returns `owned-stale` when the directory is provably MMA's and therefore safe to
 * remove; `modified-conflict` when it is not, in which case it must be left alone.
 */
export async function inspectRetiredSkillOwnership(dir: string): Promise<SkillOwnershipInspection> {
  // Passing a release no marker can hold forces the stale branch, where the
  // marker's own recorded digest is the yardstick.
  return inspect(dir, null, RETIRED_SKILL_SENTINEL_RELEASE);
}

/** Never a real release string, so `marker.release` can never equal it. */
const RETIRED_SKILL_SENTINEL_RELEASE = ' retired';

async function inspect(
  dir: string,
  renderedDigest: string | null,
  installedRelease: string,
): Promise<SkillOwnershipInspection> {
  // A retired skill has no render, and the digest of no files is a real digest —
  // so this field never carries anything that is not one.
  const digest = renderedDigest ?? computeSkillDigest(new Map());

  const entry = await classifyDirEntry(dir);
  if (entry === 'absent') return { state: 'unowned', digest };
  if (entry === 'other') {
    return { state: 'modified-conflict', digest, reason: new UnprovableSkillEntryError(dir).message };
  }

  const markerPath = join(dir, SKILL_OWNERSHIP_MARKER_FILE);
  let markerBytes: Buffer;
  try {
    // lstat first: a marker that is itself a symlink proves nothing about this
    // directory, only about wherever it points.
    if (!(await lstat(markerPath)).isFile()) {
      return {
        state: 'modified-conflict',
        digest,
        reason: new UnprovableSkillEntryError(markerPath).message,
      };
    }
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

  const isCurrentRelease = marker.release === installedRelease;
  const conflict = (reason: string): SkillOwnershipInspection => ({
    state: 'modified-conflict',
    digest,
    recordedRelease: marker.release,
    recordedDigest: marker.sha256,
    reason,
  });

  let installedFiles: Map<string, Buffer>;
  try {
    installedFiles = await readInstalledRegularFiles(dir);
  } catch (err) {
    if (err instanceof UnprovableSkillEntryError) return conflict(err.message);
    throw err;
  }

  // The yardstick differs by release, but SOMETHING on disk is always checked.
  // For the current release the render itself is authoritative (and the marker
  // must agree with it). For a superseded release the render is unavailable, so
  // the marker's own recorded digest is the yardstick — still a correlation
  // against real bytes, never a bare "the marker claims this is ours".
  if (isCurrentRelease && marker.sha256 !== digest) {
    return conflict(
      `${dir} carries a marker for release ${marker.release} whose digest does not match what that release renders `
      + '— it was modified outside MMA, so it is left untouched.',
    );
  }
  const expectedDigest = isCurrentRelease ? digest : marker.sha256;
  // An otherwise empty marker directory is a recoverable interrupted install: it
  // holds nothing to preserve, and the marker still proves MMA created it. But
  // "no regular FILES" is not the same as "nothing there" — a directory standing
  // where the render expects a file contributes no files either, and would slip
  // through this carve-out with no digest check at all. So the carve-out is
  // conditioned on the directory being empty apart from its marker, not merely on
  // the walked file set being empty.
  const isEmptyApartFromMarker = installedFiles.size === 0
    && (await readdir(dir)).every((name) => name === SKILL_OWNERSHIP_MARKER_FILE);
  if (!isEmptyApartFromMarker && computeSkillDigest(installedFiles) !== expectedDigest) {
    return conflict(
      `${dir} does not match the digest recorded for release ${marker.release} — its contents were modified outside MMA, so it is left untouched.`,
    );
  }

  return {
    state: isCurrentRelease ? 'owned' : 'owned-stale',
    digest,
    recordedRelease: marker.release,
    recordedDigest: marker.sha256,
  };
}
