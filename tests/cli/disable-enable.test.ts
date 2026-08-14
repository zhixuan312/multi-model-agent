/**
 * disable / enable CLI tests — roster-driven (Task I-8).
 *
 * The `~/.mma/skills-disabled.json` sticky sentinel (disabled-state.ts) was
 * retired in Task I-7; Task I-8 replaces "stays off across a later sync"
 * with the declared `clients` roster (`config.clients.<ClientId> = 'off'`),
 * persisted to the config file `disable`/`enable` are given, and enforced by
 * the SAME provisioning service `mma clients`/`mma sync-skills` read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

import { runSyncSkills } from '../../packages/server/src/cli/sync-skills.js';
import { readFileSync } from 'node:fs';
import { runDisable, runEnable, ToggleExitCode } from '../../packages/server/src/cli/toggle.js';
import { SUPPORTED_SKILLS, SUPPORTED_COMMANDS } from '../../packages/server/src/skill-install/discover.js';

function makeFakeHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'mma-toggle-home-'));
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

/** A pre-existing, minimal config file — `disable`/`enable`'s config-file
 *  persistence only ever PATCHES an existing file, never invents one, so
 *  every persistence assertion needs a real starting file on disk. */
function makeFakeConfigFile(home: string): string {
  const configPath = path.join(home, 'mma-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({ agents: { standard: { type: 'codex', model: 'x' }, complex: { type: 'codex', model: 'x' } } }, null, 2),
  );
  return configPath;
}

function readConfigClients(configPath: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { clients?: Record<string, string> };
  return parsed.clients ?? {};
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
function claudeCommandPath(home: string, command: string): string {
  return path.join(home, '.claude', 'commands', `${command}.md`);
}

describe('enable / disable — roster-driven', () => {
  let home: string;
  let skillsRoot: string;
  let configPath: string;

  beforeEach(() => {
    home = makeFakeHome();
    skillsRoot = makeFakeSkillsRoot();
    configPath = makeFakeConfigFile(home);
  });

  afterEach(() => {
    removeFakeHome(home);
    rmSync(skillsRoot, { recursive: true, force: true });
  });

  it('enables on a machine that has no config file yet', async () => {
    // `mma enable`/`mma disable` used to carry their OWN copy of persistDeclaredState, and that
    // copy called readFileSync unconditionally — so on a fresh machine, where no config exists
    // yet, the very first `mma enable` threw. `mma setup` worked, because the canonical
    // implementation creates the file. Two implementations, one of them wrong on first run.
    rmSync(configPath, { force: true });
    expect(existsSync(configPath)).toBe(false);

    const out = captureOutput();
    const code = await runEnable({
      argv: ['--target=claude-code'],
      homeDir: home,
      skillsRoot,
      configPath,
      stdout: out.stdout,
      stderr: out.stderr,
    });

    expect(code).toBe(0);
    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).clients).toMatchObject({ 'claude-code': 'on' });
  });

  it('enable declares --target clients on, persists it, and provisions them', async () => {
    const out = captureOutput();
    const code = await runEnable({
      argv: ['--target=claude-code', '--target=codex'],
      homeDir: home,
      skillsRoot,
      configPath,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(0);

    for (const s of SUPPORTED_SKILLS) {
      expect(existsSync(claudeSkillPath(home, s)), `claude/${s}`).toBe(true);
      expect(existsSync(codexSkillPath(home, s)), `codex/${s}`).toBe(true);
    }
    for (const c of SUPPORTED_COMMANDS) {
      expect(existsSync(claudeCommandPath(home, c)), `command/${c}`).toBe(true);
    }

    expect(readConfigClients(configPath)).toMatchObject({ 'claude-code': 'on', codex: 'on' });
  });

  it('disable removes only the targeted client and pins it off in the config file', async () => {
    await runEnable({ argv: ['--target=claude-code', '--target=codex'], homeDir: home, skillsRoot, configPath, stdout: () => true });
    for (const s of SUPPORTED_SKILLS) {
      expect(existsSync(claudeSkillPath(home, s))).toBe(true);
      expect(existsSync(codexSkillPath(home, s))).toBe(true);
    }

    const out = captureOutput();
    const code = await runDisable({
      argv: ['--target=claude-code'],
      homeDir: home,
      configPath,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(0);
    expect(out.stdoutLines.join('')).toMatch(/Disabled MMA/);
    expect(out.stdoutLines.join('')).toMatch(/mma enable/);

    // claude-code retired: skills + commands gone.
    for (const s of SUPPORTED_SKILLS) {
      expect(existsSync(claudeSkillPath(home, s)), `claude/${s} survived`).toBe(false);
    }
    for (const c of SUPPORTED_COMMANDS) {
      expect(existsSync(claudeCommandPath(home, c)), `command/${c} survived`).toBe(false);
    }
    // codex untouched — disable was scoped to claude-code only.
    for (const s of SUPPORTED_SKILLS) {
      expect(existsSync(codexSkillPath(home, s)), `codex/${s} removed`).toBe(true);
    }

    expect(readConfigClients(configPath)).toMatchObject({ 'claude-code': 'off', codex: 'on' });
  });

  it('a later bare sync-skills reading the persisted roster does not reinstall the disabled client', async () => {
    await runEnable({ argv: ['--target=claude-code', '--target=codex'], homeDir: home, skillsRoot, configPath, stdout: () => true });
    await runDisable({ argv: ['--target=claude-code'], homeDir: home, configPath, stdout: () => true });
    expect(existsSync(claudeSkillPath(home, SUPPORTED_SKILLS[0]!))).toBe(false);

    // Simulate a fresh, independent CLI invocation (e.g. npm postinstall):
    // it reads config.clients from the SAME file, not from any in-memory state.
    const declared = readConfigClients(configPath) as Record<string, 'on' | 'off'>;
    const out = captureOutput();
    const code = await runSyncSkills({
      argv: [],
      homeDir: home,
      skillsRoot,
      declared,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(0);

    // claude-code stays off; codex (still declared 'on') gets re-synced.
    for (const s of SUPPORTED_SKILLS) {
      expect(existsSync(claudeSkillPath(home, s)), `claude/${s} reinstalled`).toBe(false);
      expect(existsSync(codexSkillPath(home, s)), `codex/${s}`).toBe(true);
    }
  });

  it('--dry-run touches nothing', async () => {
    await runEnable({ argv: ['--target=claude-code'], homeDir: home, skillsRoot, configPath, stdout: () => true });

    const code = await runDisable({
      argv: ['--target=claude-code', '--dry-run'],
      homeDir: home,
      configPath,
      stdout: () => true,
    });
    expect(code).toBe(0);
    expect(existsSync(claudeSkillPath(home, SUPPORTED_SKILLS[0]!))).toBe(true);
    // Dry-run must not persist the declaration either.
    expect(readConfigClients(configPath)['claude-code']).toBe('on');
  });

  it('--json reports the action and targets', async () => {
    await runEnable({ argv: ['--target=claude-code'], homeDir: home, skillsRoot, configPath, stdout: () => true });

    const out = captureOutput();
    const code = await runDisable({ argv: ['--target=claude-code', '--json'], homeDir: home, configPath, stdout: out.stdout });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.stdoutLines.join('')) as { action: string; targets: string[]; removed: string[] };
    expect(parsed.action).toBe('disable');
    expect(parsed.targets).toEqual(['claude-code']);
    expect(parsed.removed).toEqual(['claude-code']);
  });

  it('rejects an unknown --target with exit code 3, for both disable and enable', async () => {
    const disableOut = captureOutput();
    const disableCode = await runDisable({ argv: ['--target=cline'], homeDir: home, configPath, stdout: disableOut.stdout, stderr: disableOut.stderr });
    expect(disableCode).toBe(ToggleExitCode.ERR_UNKNOWN_TARGET);
    expect(disableOut.stderrLines.join('')).toMatch(/Unknown target 'cline'/);

    const enableOut = captureOutput();
    const enableCode = await runEnable({ argv: ['--target=cline'], homeDir: home, skillsRoot, configPath, stdout: enableOut.stdout, stderr: enableOut.stderr });
    expect(enableCode).toBe(ToggleExitCode.ERR_UNKNOWN_TARGET);
    expect(enableOut.stderrLines.join('')).toMatch(/Unknown target 'cline'/);
  });

  it('enable with nothing declared and no --target reports no-clients-declared', async () => {
    const out = captureOutput();
    const code = await runEnable({ argv: [], homeDir: home, skillsRoot, stdout: out.stdout, stderr: out.stderr });
    expect(code).toBe(0);
    expect(out.stdoutLines.join('')).toMatch(/No clients declared/);
  });

  it('refuses a targeted disable without a config file, because the roster declaration must be durable', async () => {
    await runEnable({ argv: ['--target=claude-code'], homeDir: home, skillsRoot, configPath, stdout: () => true });

    const out = captureOutput();
    const code = await runDisable({
      argv: ['--target=claude-code'],
      homeDir: home,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(ToggleExitCode.ERR_PARTIAL);
    expect(existsSync(claudeSkillPath(home, SUPPORTED_SKILLS[0]!))).toBe(true);
    expect(readConfigClients(configPath)['claude-code']).toBe('on');
    expect(out.stderrLines.join('')).toMatch(/config file/i);
  });
});
