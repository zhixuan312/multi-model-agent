/**
 * disable / enable CLI tests.
 *
 * Pin the off-switch behavior:
 *   - disable removes every skill, drops manifest entries, writes the sentinel
 *   - sync-skills (i.e. the npm postinstall path) no-ops while disabled
 *   - enable clears the sentinel and reinstalls
 *   - dry-run, --json, and --target scoping
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

import { runSyncSkills } from '../../packages/server/src/cli/sync-skills.js';
import { runDisable, runEnable } from '../../packages/server/src/cli/toggle.js';
import { listEntries } from '../../packages/server/src/skill-install/manifest.js';
import { SUPPORTED_SKILLS } from '../../packages/server/src/skill-install/discover.js';
import {
  disabledStatePath,
  readDisabledState,
} from '../../packages/server/src/skill-install/disabled-state.js';

function makeFakeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'mma-toggle-home-'));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  return home;
}

function removeFakeHome(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

function writeFakeSkill(root: string, name: string, version: string): void {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\nversion: ${version}\ndescription: fixture\n---\nfixture body\n`,
    'utf8',
  );
}

function makeFakeSkillsRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mma-toggle-skills-'));
  for (const s of SUPPORTED_SKILLS) writeFakeSkill(root, s, '4.0.2');
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

function claudeSkillPath(home: string, skill: string): string {
  return path.join(home, '.claude', 'skills', skill, 'SKILL.md');
}
function codexSkillPath(home: string, skill: string): string {
  return path.join(home, '.codex', 'skills', skill, 'SKILL.md');
}

function allSkillsPresent(home: string): boolean {
  return SUPPORTED_SKILLS.every(
    (s) => existsSync(claudeSkillPath(home, s)) && existsSync(codexSkillPath(home, s)),
  );
}
function noSkillsPresent(home: string): boolean {
  return SUPPORTED_SKILLS.every(
    (s) => !existsSync(claudeSkillPath(home, s)) && !existsSync(codexSkillPath(home, s)),
  );
}

describe('disable', () => {
  let home: string;
  let skillsRoot: string;

  beforeEach(async () => {
    home = makeFakeHome();
    skillsRoot = makeFakeSkillsRoot();
    // Start from a fully installed state.
    await runSyncSkills({ argv: [], homeDir: home, skillsRoot });
    expect(allSkillsPresent(home)).toBe(true);
  });

  afterEach(() => {
    removeFakeHome(home);
    rmSync(skillsRoot, { recursive: true, force: true });
  });

  it('removes every skill, clears the manifest, and writes the sentinel', async () => {
    const out = captureOutput();
    const code = await runDisable({
      argv: [],
      homeDir: home,
      cliVersion: '9.9.9',
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(0);

    expect(noSkillsPresent(home)).toBe(true);
    expect(listEntries(home).length).toBe(0);

    const state = readDisabledState(home);
    expect(state).not.toBeNull();
    expect(state!.cliVersion).toBe('9.9.9');
    expect(state!.targets.sort()).toEqual(['claude-code', 'codex']);

    expect(out.stdoutLines.join('')).toMatch(/Disabled MMA skills/);
    expect(out.stdoutLines.join('')).toMatch(/mmagent enable/);
  });

  it('is sticky: a subsequent sync-skills (postinstall) does not reinstall', async () => {
    await runDisable({ argv: [], homeDir: home });
    expect(noSkillsPresent(home)).toBe(true);

    // Simulate `npm install` postinstall: sync-skills --if-exists --silent --best-effort
    const out = captureOutput();
    const code = await runSyncSkills({
      argv: [],
      homeDir: home,
      skillsRoot,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(0);
    expect(noSkillsPresent(home)).toBe(true);
    expect(out.stdoutLines.join('')).toMatch(/disabled/i);
  });

  it('--dry-run touches nothing', async () => {
    const code = await runDisable({ argv: ['--dry-run'], homeDir: home, stdout: () => true });
    expect(code).toBe(0);
    expect(allSkillsPresent(home)).toBe(true);
    expect(listEntries(home).length).toBe(SUPPORTED_SKILLS.length);
    expect(existsSync(disabledStatePath(home))).toBe(false);
  });

  it('--json reports the action, targets, and removed count', async () => {
    const out = captureOutput();
    const code = await runDisable({ argv: ['--json'], homeDir: home, stdout: out.stdout });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.stdoutLines.join('')) as {
      action: string; targets: string[]; removed: number;
    };
    expect(parsed.action).toBe('disable');
    expect(parsed.targets.sort()).toEqual(['claude-code', 'codex']);
    expect(parsed.removed).toBe(SUPPORTED_SKILLS.length * 2);
  });

  it('--target scopes removal and the sentinel to one client', async () => {
    const code = await runDisable({ argv: ['--target=claude-code'], homeDir: home, stdout: () => true });
    expect(code).toBe(0);

    // claude-code skills gone, codex skills untouched
    for (const s of SUPPORTED_SKILLS) {
      expect(existsSync(claudeSkillPath(home, s)), `claude/${s}`).toBe(false);
      expect(existsSync(codexSkillPath(home, s)), `codex/${s}`).toBe(true);
    }
    expect(readDisabledState(home)!.targets).toEqual(['claude-code']);

    // A later sync still installs codex but leaves claude-code disabled.
    await runSyncSkills({ argv: [], homeDir: home, skillsRoot, stdout: () => true });
    for (const s of SUPPORTED_SKILLS) {
      expect(existsSync(claudeSkillPath(home, s)), `claude/${s} stays off`).toBe(false);
      expect(existsSync(codexSkillPath(home, s)), `codex/${s} present`).toBe(true);
    }
  });
});

describe('enable', () => {
  let home: string;
  let skillsRoot: string;

  beforeEach(() => {
    home = makeFakeHome();
    skillsRoot = makeFakeSkillsRoot();
  });

  afterEach(() => {
    removeFakeHome(home);
    rmSync(skillsRoot, { recursive: true, force: true });
  });

  it('clears the sentinel and reinstalls every skill', async () => {
    await runSyncSkills({ argv: [], homeDir: home, skillsRoot });
    await runDisable({ argv: [], homeDir: home });
    expect(noSkillsPresent(home)).toBe(true);
    expect(existsSync(disabledStatePath(home))).toBe(true);

    const out = captureOutput();
    const code = await runEnable({
      argv: [],
      homeDir: home,
      skillsRoot,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(0);

    expect(allSkillsPresent(home)).toBe(true);
    expect(existsSync(disabledStatePath(home))).toBe(false);
  });

  it('bare enable restores a client that was scoped-disabled, not just un-pins it', async () => {
    await runSyncSkills({ argv: [], homeDir: home, skillsRoot });
    expect(allSkillsPresent(home)).toBe(true);

    // Scope-disable a single auto-detected client.
    await runDisable({ argv: ['--target=codex'], homeDir: home, stdout: () => true });
    for (const s of SUPPORTED_SKILLS) {
      expect(existsSync(codexSkillPath(home, s)), `codex/${s} off`).toBe(false);
      expect(existsSync(claudeSkillPath(home, s)), `claude/${s} on`).toBe(true);
    }
    expect(readDisabledState(home)!.targets).toEqual(['codex']);

    // Bare enable must reinstall codex AND clear the sentinel entirely.
    const code = await runEnable({ argv: [], homeDir: home, skillsRoot, stdout: () => true });
    expect(code).toBe(0);
    expect(allSkillsPresent(home)).toBe(true);
    expect(existsSync(disabledStatePath(home))).toBe(false);
  });

  it('is a plain sync when nothing was disabled', async () => {
    const out = captureOutput();
    const code = await runEnable({
      argv: [],
      homeDir: home,
      skillsRoot,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(0);
    expect(allSkillsPresent(home)).toBe(true);
  });
});
