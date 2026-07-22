// tests/server/skill-install/skill-drift.test.ts
//
// Regression guard for backlog finding #1: GET /status reported skillVersion /
// skillCompatible as permanently null because it read a filename nothing writes
// (skills-install-manifest.json) and used a stale major===3 compat check. The
// canonical mechanism reads the REAL install-manifest.json (listEntries) and
// compares the installed version against the bundled SKILL.md (isSkillBehind).
// deriveSkillManifestInfo is the single implementation both serve.ts and the
// /status handler consume.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { deriveSkillManifestInfo } from '../../../packages/server/src/skill-install/skill-drift.js';
import { readSkillContent } from '../../../packages/server/src/skill-install/discover.js';

// The bundled version of a real packaged skill — computed dynamically so the test
// is robust whether readSkillContent resolves src ("0.0.0-unreleased") or a built
// dist (the injected package version).
const SKILL = 'mma-audit';
const bundledVersion = matter(readSkillContent(SKILL) ?? '').data['version'] as string;

function writeManifest(homeDir: string, entries: unknown[]): void {
  mkdirSync(join(homeDir, '.mma'), { recursive: true });
  writeFileSync(
    join(homeDir, '.mma', 'install-manifest.json'),
    JSON.stringify({ version: 2, entries }, null, 2),
    'utf-8',
  );
}

describe('deriveSkillManifestInfo', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mma-skilldrift-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('returns { null, null } when no manifest is installed', () => {
    expect(deriveSkillManifestInfo(home)).toEqual({ skillVersion: null, skillCompatible: null });
  });

  it('reports the installed version and skillCompatible=true when installed skills match the bundle', () => {
    writeManifest(home, [
      { name: SKILL, skillVersion: bundledVersion, installedAt: 1, targets: ['claude-code'] },
    ]);
    expect(deriveSkillManifestInfo(home)).toEqual({
      skillVersion: bundledVersion,
      skillCompatible: true,
    });
  });

  it('reports skillCompatible=false when an installed skill is behind the bundle', () => {
    writeManifest(home, [
      { name: SKILL, skillVersion: `${bundledVersion}-stale`, installedAt: 1, targets: ['claude-code'] },
    ]);
    const info = deriveSkillManifestInfo(home);
    expect(info.skillVersion).toBe(`${bundledVersion}-stale`);
    expect(info.skillCompatible).toBe(false);
  });

  it('reads the REAL install-manifest.json (not the orphaned skills-install-manifest.json path)', () => {
    // Writing to the wrong (legacy) filename must NOT be picked up.
    mkdirSync(join(home, '.mma'), { recursive: true });
    writeFileSync(
      join(home, '.mma', 'skills-install-manifest.json'),
      JSON.stringify({ skillVersion: '3.0.0' }),
      'utf-8',
    );
    // Only the wrong file exists → no real manifest → null/null.
    expect(deriveSkillManifestInfo(home)).toEqual({ skillVersion: null, skillCompatible: null });
  });
});
