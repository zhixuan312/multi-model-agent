import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUpdateSkills } from '../../packages/server/src/cli/update-skills.js';
import type { InstallManifest } from '../../packages/core/src/tool-surface/manifest.js';

function makeFakeHome(initial: InstallManifest): string {
  const home = mkdtempSync(join(tmpdir(), 'mma-backfill-'));
  mkdirSync(join(home, '.multi-model'), { recursive: true });
  writeFileSync(join(home, '.multi-model', 'install-manifest.json'), JSON.stringify(initial), 'utf8');
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  return home;
}

describe('manifest backfill on update-skills', () => {
  let originalHome: string | undefined;
  beforeEach(() => { originalHome = process.env.HOME; });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('installs missing skills to the union of existing client targets', async () => {
    const home = makeFakeHome({
      version: 2,
      entries: [{ name: 'mma-delegate', skillVersion: '0.0.0-unreleased', targets: ['claude-code'], installedAt: Date.now() }],
    });
    process.env.HOME = home;
    await runUpdateSkills({ silent: true });
    expect(existsSync(join(home, '.claude', 'skills', 'mma-investigate', 'SKILL.md'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(home, '.multi-model', 'install-manifest.json'), 'utf8'));
    expect(manifest.entries.find((e: any) => e.name === 'mma-investigate')).toBeDefined();
  });

  it('does not install anything when manifest is empty', async () => {
    const home = makeFakeHome({ version: 2, entries: [] });
    process.env.HOME = home;
    await runUpdateSkills({ silent: true });
    expect(existsSync(join(home, '.claude', 'skills', 'mma-investigate'))).toBe(false);
  });

  it('installs to all targets used by any existing entry', async () => {
    const home = makeFakeHome({
      version: 2,
      entries: [
        { name: 'mma-delegate', skillVersion: '0.0.0-unreleased', targets: ['claude-code'], installedAt: Date.now() },
        { name: 'mma-audit',    skillVersion: '0.0.0-unreleased', targets: ['codex'],      installedAt: Date.now() },
      ],
    });
    process.env.HOME = home;
    await runUpdateSkills({ silent: true });
    const m = JSON.parse(readFileSync(join(home, '.multi-model', 'install-manifest.json'), 'utf8'));
    const inv = m.entries.find((e: any) => e.name === 'mma-investigate');
    expect(inv).toBeDefined();
    expect(inv.targets.sort()).toEqual(['claude-code', 'codex']);
  });

  it('serve auto-update with autoUpdateSkills=false prints warning instead of installing', async () => {
    const home = makeFakeHome({
      version: 2,
      entries: [{ name: 'mma-delegate', skillVersion: '0.0.0-unreleased', targets: ['claude-code'], installedAt: Date.now() }],
    });
    process.env.HOME = home;
    const { maybeAutoUpdateSkills } = await import('../../packages/server/src/cli/serve.js');
    let stderrBuf = '';
    const config = { server: { autoUpdateSkills: false } } as any;
    await maybeAutoUpdateSkills(config, (s: string) => { stderrBuf += s; return true; });
    expect(stderrBuf).toContain('mma-investigate');
    expect(stderrBuf).toMatch(/new skill\(s\) available/);
    expect(existsSync(join(home, '.claude', 'skills', 'mma-investigate'))).toBe(false);
  });
});
