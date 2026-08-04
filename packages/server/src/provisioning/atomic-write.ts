/**
 * Crash-safe file replacement.
 *
 * Every durable file provisioning owns — a client's MCP registration, a recovery
 * marker — has the same requirement: a crash partway through a write must leave
 * either the old content or the new one, never a torn file between them. The way
 * to get that is always the same too: write a sibling temp file (same directory,
 * so the rename stays within one filesystem and is therefore atomic), fsync it,
 * then rename it over the target.
 *
 * This lives in its own module rather than inside `registration-writer.ts` because
 * `marker-store.ts` needs exactly this and nothing else. Reaching into the
 * registration writer for it would drag in the whole per-client writer graph —
 * eight writers and the capability registry — to write one small JSON file, and
 * would make the marker store's dependencies badly misrepresent what it does.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** Injected filesystem primitives — narrow and synchronous, so ordering and
 *  failure paths are testable without a real disk race. */
export interface AtomicFsDeps {
  /** Current bytes at `path`, or `undefined` when it does not exist. */
  readConfig(path: string): Buffer | undefined;
  createTemp(path: string): string;
  write(path: string, bytes: Buffer): void;
  fsync(path: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

export function realFsDeps(): AtomicFsDeps {
  return {
    readConfig: (path) => (existsSync(path) ? readFileSync(path) : undefined),
    createTemp: (path) => `${path}.mma-tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
    write: (path, bytes) => writeFileSync(path, bytes),
    fsync: (path) => {
      const fd = openSync(path, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    rename: (from, to) => renameSync(from, to),
    remove: (path) => rmSync(path, { force: true }),
  };
}

/** Replace `path`'s contents with `bytes`, atomically. Any failure leaves the
 *  original bytes untouched and removes the temp file. */
export function atomicWriteBytes(fs: AtomicFsDeps, path: string, bytes: Buffer): void {
  const tempPath = fs.createTemp(path);
  try {
    fs.write(tempPath, bytes);
    fs.fsync(tempPath);
    fs.rename(tempPath, path);
  } catch (err) {
    try {
      fs.remove(tempPath);
    } catch {
      /* best-effort cleanup only; must not mask the original failure */
    }
    throw new Error(`Failed to atomically write ${path}; the original file was left unchanged`, { cause: err });
  }
}
