import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'install-id';

/**
 * Delete the legacy `install-id` file if present.
 *
 * The persistent install identity now lives in `identity.json` (see identity.ts,
 * which bundles installId + signing keys). This removes the pre-`identity.json`
 * standalone `install-id` file during identity revocation, for installs that
 * upgraded from the old scheme. New installs never create it.
 */
export function deleteInstallId(dir: string): void {
  const path = join(dir, FILE);
  if (existsSync(path)) unlinkSync(path);
}
