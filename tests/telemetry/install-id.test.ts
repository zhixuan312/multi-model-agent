import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteInstallId } from '../../packages/server/src/telemetry/install-id.js';

// The persistent install identity lives in identity.json (see identity.ts). The only
// surviving install-id.ts export is deleteInstallId, which cleans up the legacy
// standalone `install-id` file during identity revocation for upgraded installs.
describe('deleteInstallId (legacy install-id file cleanup)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mma-test-')); });

  it('removes a legacy install-id file if present', () => {
    writeFileSync(join(dir, 'install-id'), 'legacy-id');
    deleteInstallId(dir);
    expect(existsSync(join(dir, 'install-id'))).toBe(false);
  });

  it('is a no-op when no legacy install-id file exists', () => {
    expect(() => deleteInstallId(dir)).not.toThrow();
    expect(existsSync(join(dir, 'install-id'))).toBe(false);
  });
});
