/**
 * sync-skills CLI tests.
 *
 * Pin the upsert behavior: bootstrap, up-to-date short-circuit, version
 * upgrade, orphan removal, dry-run, --target scoping, no-clients-detected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runSyncSkills } from '../../packages/server/src/cli/sync-skills.js';
import { listEntries, appendEntry } from '../../packages/core/src/tool-surface/manifest.js';
import { SUPPORTED_SKILLS } from '../../packages/core/src/tool-surface/discover.js';

function makeFakeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'mma-sync-home-'));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  return home;
}

function removeFakeHome(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

function writeFakeSkill(root: string, name: string, version: string, body = 'fixture body'): void {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const front = `---\nname: ${name}\nversion: ${version}\ndescription: fixture\n---\n${body}\n`;
  writeFileSync(path.join(dir, 'SKILL.md'), front, 'utf8');
}

function makeFakeSkillsRoot(versionMap: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mma-sync-skills-'));
  for (const [name, ver] of Object.entries(versionMap)) writeFakeSkill(root, name, ver);
  return root;
}

function captureOutput() {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdout: (s: string) => { stdoutLines.push(s); return true; },
    stderr: (s: string) => { stderrLines.push(s); return true; },
    stdoutLines,
    stderrLines,
  };
}

function readSkillVersionAt(p: string): string | null {
  if (!existsSync(p)) return null;
  const content = readFileSync(p, 'utf8');
  const m = content.match(/version:\s*(\S+)/);
  return m ? m[1]! : null;
}

describe('sync-skills — bootstrap (empty manifest, dirs present)', () => {
  let home: string;
  let skillsRoot: string;

  beforeEach(() => {
    home = makeFakeHome();
    // Canonical bundle: every supported skill at version 4.0.2.
    const versions: Record<string, string> = {};
    for (const s of SUPPORTED_SKILLS) versions[s] = '4.0.2';
    skillsRoot = makeFakeSkillsRoot(versions);
  });

  afterEach(() => {
    removeFakeHome(home);
    rmSync(skillsRoot, { recursive: true, force: true });
  });

  it('installs every supported skill into every detected client', async () => {
    const out = captureOutput();
    const code = await runSyncSkills({
      argv: [],
      homeDir: home,
      skillsRoot,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(0);

    // Each (skill × client) is on disk
    for (const skill of SUPPORTED_SKILLS) {
      const claudePath = path.join(home, '.claude', 'skills', skill, 'SKILL.md');
      const codexPath = path.join(home, '.codex', 'skills', skill, 'SKILL.md');
      expect(existsSync(claudePath), `claude/${skill}`).toBe(true);
      expect(existsSync(codexPath), `codex/${skill}`).toBe(true);
    }

    // Manifest reflects every skill against both targets
    const entries = listEntries(home);
    expect(entries.length).toBe(SUPPORTED_SKILLS.length);
    for (const e of entries) {
      expect(e.skillVersion).toBe('4.0.2');
      expect(e.targets.sort()).toEqual(['claude-code', 'codex']);
    }

    expect(out.stdoutLines.join('')).toMatch(/Synced \d+ skill\(s\) → claude-code, codex/);
  });
});

describe('sync-skills — up-to-date short-circuit', () => {
  let home: string;
  let skillsRoot: string;

  beforeEach(() => {
    home = makeFakeHome();
    const versions: Record<string, string> = {};
    for (const s of SUPPORTED_SKILLS) versions[s] = '4.0.2';
    skillsRoot = makeFakeSkillsRoot(versions);
  });

  afterEach(() => {
    removeFakeHome(home);
    rmSync(skillsRoot, { recursive: true, force: true });
  });

  it('re-running sync-skills on a clean install reports up-to-date and changes nothing', async () => {
    // First run installs everything
    await runSyncSkills({ argv: [], homeDir: home, skillsRoot });
    const claudePath = path.join(home, '.claude', 'skills', 'mma-delegate', 'SKILL.md');
    const mtimeBefore = statSync(claudePath).mtimeMs;

    // Sleep just long enough that mtime would observably change if rewritten
    await new Promise((r) => setTimeout(r, 25));

    // Second run should be a no-op for every (skill × client)
    const out = captureOutput();
    const code = await runSyncSkills({
      argv: [],
      homeDir: home,
      skillsRoot,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(0);
    const summary = out.stdoutLines.join('');
    expect(summary).toMatch(/up-to-date/);
    expect(summary).not.toMatch(/installed|updated/);

    // mtime did not change — file was not rewritten
    expect(statSync(claudePath).mtimeMs).toBe(mtimeBefore);
  });
});

describe('sync-skills — version upgrade', () => {
  let home: string;
  let skillsRoot: string;

  beforeEach(() => {
    home = makeFakeHome();
    const versions: Record<string, string> = {};
    for (const s of SUPPORTED_SKILLS) versions[s] = '4.0.2';
    skillsRoot = makeFakeSkillsRoot(versions);
  });

  afterEach(() => {
    removeFakeHome(home);
    rmSync(skillsRoot, { recursive: true, force: true });
  });

  it('overwrites stale on-disk skills when canonical version differs', async () => {
    // Plant an old SKILL.md at a stale version
    const stalePath = path.join(home, '.claude', 'skills', 'mma-delegate', 'SKILL.md');
    mkdirSync(path.dirname(stalePath), { recursive: true });
    writeFileSync(stalePath, '---\nname: mma-delegate\nversion: 3.12.7\n---\nold body\n');
    // Manifest still says it's installed at the old version
    appendEntry('mma-delegate', '3.12.7', ['claude-code'], home);

    const code = await runSyncSkills({ argv: ['--json'], homeDir: home, skillsRoot, stdout: () => true });
    expect(code).toBe(0);

    expect(readSkillVersionAt(stalePath)).toBe('4.0.2');
  });
});

describe('sync-skills — orphan removal', () => {
  let home: string;
  let skillsRoot: string;

  beforeEach(() => {
    home = makeFakeHome();
    const versions: Record<string, string> = {};
    for (const s of SUPPORTED_SKILLS) versions[s] = '4.0.2';
    skillsRoot = makeFakeSkillsRoot(versions);
  });

  afterEach(() => {
    removeFakeHome(home);
    rmSync(skillsRoot, { recursive: true, force: true });
  });

  it('removes a manifest skill that no longer ships and deletes its on-disk copy', async () => {
    const orphanName = 'mma-clarifications'; // removed in 4.0.0; no longer in SUPPORTED_SKILLS
    const orphanPath = path.join(home, '.claude', 'skills', orphanName, 'SKILL.md');
    mkdirSync(path.dirname(orphanPath), { recursive: true });
    writeFileSync(orphanPath, '---\nname: mma-clarifications\nversion: 3.12.7\n---\norphan body\n');
    appendEntry(orphanName, '3.12.7', ['claude-code'], home);

    const code = await runSyncSkills({ argv: [], homeDir: home, skillsRoot, stdout: () => true });
    expect(code).toBe(0);

    expect(existsSync(orphanPath)).toBe(false);
    const entries = listEntries(home);
    expect(entries.find((e) => e.name === orphanName)).toBeUndefined();
  });
});

describe('sync-skills — dry-run', () => {
  let home: string;
  let skillsRoot: string;

  beforeEach(() => {
    home = makeFakeHome();
    const versions: Record<string, string> = {};
    for (const s of SUPPORTED_SKILLS) versions[s] = '4.0.2';
    skillsRoot = makeFakeSkillsRoot(versions);
  });

  afterEach(() => {
    removeFakeHome(home);
    rmSync(skillsRoot, { recursive: true, force: true });
  });

  it('reports planned actions without touching disk or manifest', async () => {
    const out = captureOutput();
    const code = await runSyncSkills({
      argv: ['--dry-run'],
      homeDir: home,
      skillsRoot,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(0);

    // Disk untouched
    expect(existsSync(path.join(home, '.claude', 'skills', 'mma-delegate', 'SKILL.md'))).toBe(false);
    // Manifest still empty (or at least no entries got appended)
    expect(listEntries(home).length).toBe(0);

    expect(out.stdoutLines.join('')).toMatch(/Would sync \d+ skill\(s\)/);
  });
});

describe('sync-skills — --target scoping', () => {
  let home: string;
  let skillsRoot: string;

  beforeEach(() => {
    home = makeFakeHome();
    const versions: Record<string, string> = {};
    for (const s of SUPPORTED_SKILLS) versions[s] = '4.0.2';
    skillsRoot = makeFakeSkillsRoot(versions);
  });

  afterEach(() => {
    removeFakeHome(home);
    rmSync(skillsRoot, { recursive: true, force: true });
  });

  it('--target=claude-code installs only into claude-code', async () => {
    const code = await runSyncSkills({
      argv: ['--target=claude-code'],
      homeDir: home,
      skillsRoot,
      stdout: () => true,
    });
    expect(code).toBe(0);
    expect(existsSync(path.join(home, '.claude', 'skills', 'mma-delegate', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(home, '.codex', 'skills', 'mma-delegate', 'SKILL.md'))).toBe(false);
  });

  it('rejects an unknown --target with exit code 3', async () => {
    const out = captureOutput();
    const code = await runSyncSkills({
      argv: ['--target=cline'],
      homeDir: home,
      skillsRoot,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(3);
    expect(out.stderrLines.join('')).toMatch(/Unknown target 'cline'/);
  });
});

describe('sync-skills — no clients detected', () => {
  it('exits 0 with a friendly message when no client dirs exist', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mma-sync-empty-'));
    try {
      const out = captureOutput();
      const code = await runSyncSkills({
        argv: [],
        homeDir: home,
        skillsRoot: '/nonexistent', // never reached
        stdout: out.stdout,
        stderr: out.stderr,
      });
      expect(code).toBe(0);
      expect(out.stdoutLines.join('')).toMatch(/No clients detected/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('sync-skills — --if-exists postinstall guard', () => {
  it('exits 0 silently when no manifest exists yet', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mma-sync-noman-'));
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    try {
      const out = captureOutput();
      const code = await runSyncSkills({
        argv: [],
        homeDir: home,
        skillsRoot: '/nonexistent',
        ifExists: true,
        stdout: out.stdout,
        stderr: out.stderr,
      });
      expect(code).toBe(0);
      expect(out.stdoutLines.length).toBe(0);
      expect(out.stderrLines.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
