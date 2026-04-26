import { readFileSync, openSync, closeSync, writeSync, fsyncSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const FILE = 'install-id';

export function hasInstallId(dir: string): boolean {
  return existsSync(join(dir, FILE));
}

/**
 * Atomic create-or-read.
 * - `openSync(path, 'wx')` is exclusive — succeeds only if the file does not exist.
 * - Two concurrent processes racing here: one wins the create, the other gets EEXIST
 *   and falls through to the read path. No `proper-lockfile` needed for this one.
 * - We `fsyncSync` the WRITE descriptor (not a re-opened read fd) so the kernel
 *   actually flushes the bytes; this is the data-durability guarantee that survives
 *   power loss.
 */
export function getOrCreateInstallId(dir: string): string {
  const path = join(dir, FILE);
  // Fast path: file already exists.
  if (existsSync(path)) {
    return readFileSync(path, 'utf8').trim();
  }
  // Race-safe create.
  const id = randomUUID();
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);  // EEXIST if a concurrent process beat us
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      return readFileSync(path, 'utf8').trim();
    }
    throw e;
  }
  try {
    writeSync(fd, id);
    fsyncSync(fd);  // flush data to durable storage on the WRITE fd
  } finally {
    closeSync(fd);
  }
  return id;
}

export function deleteInstallId(dir: string): void {
  const path = join(dir, FILE);
  if (existsSync(path)) unlinkSync(path);
}
