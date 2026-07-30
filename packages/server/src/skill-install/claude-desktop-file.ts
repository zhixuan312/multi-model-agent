/**
 * The ONE crash-safe write seam for Claude Desktop's configuration file.
 *
 * Claude Desktop's `claude_desktop_config.json` is a file the USER owns — it holds
 * their preferences alongside any MCP servers they configured by hand. MMA edits one
 * member of it (`mcpServers.mma`), so the central promise is that a write can never
 * leave that file truncated, empty, or half-written.
 *
 * A plain truncate-and-write cannot honour that: a crash, a full disk, or an
 * interrupted write corrupts the file through an ordinary operational failure rather
 * than a logic bug. So every byte-changing write goes through this function, in this
 * order:
 *
 *   1. Back up the existing bytes to `<configPath>.bak.<YYYYMMDDHHmmss>` and fsync
 *      it — but only for the FIRST byte-changing modification. A pre-existing backup
 *      is never overwritten, because the value of a backup is that it holds the
 *      user's ORIGINAL content, not the state one write ago.
 *   2. Write the new content to a temp file in the SAME directory (same filesystem,
 *      so the rename below is atomic) and fsync it.
 *   3. Rename the temp file over the config.
 *
 * On any failure at any step the original config bytes are left untouched and the
 * temp file is removed. Install and uninstall both call this; there is deliberately
 * no second atomic-write path to drift from it.
 *
 * Every filesystem operation is injected so the ordering and the failure paths can
 * be tested without a real disk-full condition.
 */

/** Injected filesystem operations. Kept narrow and synchronous — this seam does
 *  ordering, not I/O policy. */
export interface AtomicClaudeDesktopFileDeps {
  /** Absolute path of an existing backup for this config, or undefined when none
   *  exists. Named explicitly because "first byte-changing modification" is
   *  otherwise not decidable: without it, a second write cannot tell that the
   *  user's original bytes were already preserved. */
  findExistingDesktopBackup(configPath: string): string | undefined;
  /** Create and return the path of a temp file in the SAME directory as the config. */
  createTemp(configPath: string): string;
  write(path: string, bytes: Buffer): void;
  fsync(path: string): void;
  writeBackup(path: string, bytes: Buffer): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  /** Injected clock so the backup filename is deterministic under test. */
  now(): Date;
}

export interface AtomicClaudeDesktopWriteInput {
  configPath: string;
  /** The config's current bytes, or undefined when the file does not exist yet
   *  (nothing to back up in that case). */
  originalBytes: Buffer | undefined;
  nextBytes: Buffer;
}

/** `YYYYMMDDHHmmss` in local time — the backup suffix. */
function backupStamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    String(at.getFullYear())
    + pad(at.getMonth() + 1)
    + pad(at.getDate())
    + pad(at.getHours())
    + pad(at.getMinutes())
    + pad(at.getSeconds())
  );
}

/**
 * Replace the Desktop config's contents atomically.
 *
 * @returns the backup path when this call created one, else `null`.
 * @throws on any backup/write/fsync/rename failure, having left the original
 *         config bytes unchanged and removed any temp file it created.
 */
export async function atomicWriteClaudeDesktopConfig(
  input: AtomicClaudeDesktopWriteInput,
  deps: AtomicClaudeDesktopFileDeps,
): Promise<string | null> {
  const { configPath, originalBytes, nextBytes } = input;

  // 1. Backup first, and only once. Do this BEFORE creating a temp file so a failing
  //    backup leaves nothing at all behind — the caller's bytes are still on disk and
  //    untouched.
  let backupPath: string | null = null;
  if (originalBytes !== undefined && deps.findExistingDesktopBackup(configPath) === undefined) {
    backupPath = `${configPath}.bak.${backupStamp(deps.now())}`;
    deps.writeBackup(backupPath, originalBytes);
    deps.fsync(backupPath);
  }

  // 2 + 3. Temp write, fsync, then atomic rename over the config. Any failure here
  //        removes the temp and rethrows; the config is never written in place, so it
  //        cannot be observed half-updated.
  const tempPath = deps.createTemp(configPath);
  try {
    deps.write(tempPath, nextBytes);
    deps.fsync(tempPath);
    deps.rename(tempPath, configPath);
  } catch (err) {
    // Best-effort cleanup: a failing remove must not mask why the write failed.
    try {
      deps.remove(tempPath);
    } catch { /* ignore */ }
    throw new Error(
      `Failed to atomically write Claude Desktop config at ${configPath}; the original file was left unchanged`,
      { cause: err },
    );
  }

  return backupPath;
}
