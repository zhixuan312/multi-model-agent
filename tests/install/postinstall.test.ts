/**
 * tests/install/postinstall.test.ts — verify the npm postinstall wrapper.
 *
 * The wrapper runs `mmagent update-skills --if-exists --silent --best-effort`.
 * Key contract: on every failure mode (dist missing, spawn error) the wrapper
 * must exit 0 so npm install never breaks the user's environment.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const postinstall = resolve('packages/server/scripts/postinstall.js');

describe('postinstall wrapper', () => {
  it('exits 0 when dist/cli/index.js does not exist (fresh checkout)', () => {
    // Run a copy of the wrapper from a staging dir whose ../dist/ is absent.
    const staging = mkdtempSync(join(tmpdir(), 'postinstall-nodist-'));
    const scriptsDir = join(staging, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    // Mimic the server package's "type":"module" so the ESM wrapper loads correctly.
    writeFileSync(join(staging, 'package.json'), JSON.stringify({ type: 'module' }));
    try {
      writeFileSync(join(scriptsDir, 'postinstall.js'), readFileSync(postinstall, 'utf8'));
      const r = spawnSync(process.execPath, [join(scriptsDir, 'postinstall.js')], { encoding: 'utf8' });
      expect(r.status).toBe(0);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('exits 0 when dist exists and update-skills succeeds (no manifest → no-op)', () => {
    // Run the real wrapper against the real dist; --if-exists means no manifest = silent 0.
    // HOME is pointed at a temp dir so we do NOT touch the developer's real manifest.
    const fakeHome = mkdtempSync(join(tmpdir(), 'postinstall-fakehome-'));
    try {
      const r = spawnSync(process.execPath, [postinstall], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fakeHome },
      });
      expect(r.status).toBe(0);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
