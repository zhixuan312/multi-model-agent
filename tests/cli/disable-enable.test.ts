/**
 * disable / enable CLI tests.
 *
 * Pin the off-switch behavior:
 *   - disable removes every skill and drops manifest entries
 *   - enable reinstalls
 *   - dry-run, --json, and --target scoping
 *
 * The `~/.mma/skills-disabled.json` sticky sentinel (disabled-state.ts) was
 * retired in Task I-7 -- Task I-8 replaces "stays off across a later sync"
 * with the declared `clients` roster (`config.clients.<ClientId> = 'off'`).
 * Until I-8 lands, `mma disable` still removes skills immediately, but a
 * SUBSEQUENT `mma sync-skills` (e.g. the npm postinstall hook) is no longer
 * told to skip a client that was previously disabled -- the cases below that
 * used to pin stickiness are adjusted to that intermediate state rather than
 * left importing a deleted module.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { SUPPORTED_SKILLS, SUPPORTED_COMMANDS } from '../../packages/server/src/skill-install/discover.js';

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
  for (const c of SUPPORTED_COMMANDS) writeFakeSkill(root, c, '4.0.2');
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

  it('removes every skill and clears the manifest', async () => {
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

    expect(out.stdoutLines.join('')).toMatch(/Disabled MMA skills/);
    expect(out.stdoutLines.join('')).toMatch(/mma enable/);
  });

  it('a subsequent sync-skills (postinstall) reinstalls -- stickiness lands in Task I-8', async () => {
    await runDisable({ argv: [], homeDir: home });
    expect(noSkillsPresent(home)).toBe(true);

    // Simulate `npm install` postinstall: sync-skills --if-exists --silent --best-effort.
    // Without the retired sentinel there is nothing (yet) telling this sync to
    // skip a previously-disabled client -- it reinstalls, same as any other
    // detected client. Task I-8's declared `clients: 'off'` roster is what
    // restores the "stays off" guarantee this case used to pin.
    const out = captureOutput();
    const code = await runSyncSkills({
      argv: [],
      homeDir: home,
      skillsRoot,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(0);
    expect(allSkillsPresent(home)).toBe(true);
  });

  it('--dry-run touches nothing', async () => {
    const code = await runDisable({ argv: ['--dry-run'], homeDir: home, stdout: () => true });
    expect(code).toBe(0);
    expect(allSkillsPresent(home)).toBe(true);
    expect(listEntries(home).length).toBe(SUPPORTED_SKILLS.length);
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
    // Skills across both targets, PLUS the Claude-Code-only SDLC commands.
    // `sync-skills` installs those commands, so a disable that skipped them
    // left /mma-flow and /mma-breakout behind — shadowing the plugin's
    // /mma:flow and /mma:breakout, and reappearing for a user who believed
    // MMA was fully removed.
    expect(parsed.removed).toBe(SUPPORTED_SKILLS.length * 2 + SUPPORTED_COMMANDS.length);
  });

  it('removes the Claude-Code SDLC commands, not just the skills', async () => {
    for (const c of SUPPORTED_COMMANDS) {
      expect(existsSync(path.join(home, '.claude', 'commands', `${c}.md`)), `${c} not seeded`).toBe(true);
    }
    const code = await runDisable({ argv: ['--target=claude-code'], homeDir: home, stdout: () => true });
    expect(code).toBe(0);
    for (const c of SUPPORTED_COMMANDS) {
      expect(existsSync(path.join(home, '.claude', 'commands', `${c}.md`)), `${c} survived disable`).toBe(false);
    }
  });

  it('--target scopes removal to one client', async () => {
    const code = await runDisable({ argv: ['--target=claude-code'], homeDir: home, stdout: () => true });
    expect(code).toBe(0);

    // claude-code skills gone, codex skills untouched
    for (const s of SUPPORTED_SKILLS) {
      expect(existsSync(claudeSkillPath(home, s)), `claude/${s}`).toBe(false);
      expect(existsSync(codexSkillPath(home, s)), `codex/${s}`).toBe(true);
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

  it('reinstalls every skill after a disable', async () => {
    await runSyncSkills({ argv: [], homeDir: home, skillsRoot });
    await runDisable({ argv: [], homeDir: home });
    expect(noSkillsPresent(home)).toBe(true);

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

  it('bare enable restores a client that was scoped-disabled', async () => {
    await runSyncSkills({ argv: [], homeDir: home, skillsRoot });
    expect(allSkillsPresent(home)).toBe(true);

    // Scope-disable a single auto-detected client.
    await runDisable({ argv: ['--target=codex'], homeDir: home, stdout: () => true });
    for (const s of SUPPORTED_SKILLS) {
      expect(existsSync(codexSkillPath(home, s)), `codex/${s} off`).toBe(false);
      expect(existsSync(claudeSkillPath(home, s)), `claude/${s} on`).toBe(true);
    }

    // Bare enable must reinstall codex.
    const code = await runEnable({ argv: [], homeDir: home, skillsRoot, stdout: () => true });
    expect(code).toBe(0);
    expect(allSkillsPresent(home)).toBe(true);
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
