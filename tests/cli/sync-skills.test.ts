/**
 * sync-skills CLI tests — roster-driven (Task I-8).
 *
 * `mma sync-skills` provisions the DECLARED-'on' roster (`config.clients`)
 * through the shared `ProvisioningService`; detection alone (a client
 * present but never declared) must never provision it (FR-7a) — it is
 * reported 'suggested' only. An explicit `--target=<ClientId>` (or
 * `--all-targets`) forces provisioning regardless of declared state, the
 * same one-off-override shape as `mma mcp install <ClientId>`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runSyncSkills, ExitCode } from '../../packages/server/src/cli/sync-skills.js';
import { listEntries } from '../../packages/server/src/skill-install/manifest.js';
import { SUPPORTED_SKILLS, SUPPORTED_COMMANDS } from '../../packages/server/src/skill-install/discover.js';

function makeFakeHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'mma-sync-home-'));
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
  const root = mkdtempSync(path.join(tmpdir(), 'mma-sync-skills-'));
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
function claudeCommandPath(home: string, command: string): string {
  return path.join(home, '.claude', 'commands', `${command}.md`);
}

describe('sync-skills — roster-driven', () => {
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

  it('provisions every declared-\'on\' client (skills, commands, manifest)', async () => {
    const out = captureOutput();
    const code = await runSyncSkills({
      argv: [],
      homeDir: home,
      skillsRoot,
      declared: { 'claude-code': 'on', codex: 'on' },
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(ExitCode.SUCCESS);

    for (const skill of SUPPORTED_SKILLS) {
      expect(existsSync(claudeSkillPath(home, skill)), `claude/${skill}`).toBe(true);
      expect(existsSync(codexSkillPath(home, skill)), `codex/${skill}`).toBe(true);
    }
    for (const command of SUPPORTED_COMMANDS) {
      expect(existsSync(claudeCommandPath(home, command)), `command/${command}`).toBe(true);
    }

    const entries = listEntries(home);
    expect(entries.length).toBe(SUPPORTED_SKILLS.length);
    for (const e of entries) {
      expect(e.skillVersion).toBe('4.0.2');
      expect(e.targets.sort()).toEqual(['claude-code', 'codex']);
    }

    expect(out.stdoutLines.join('')).toMatch(/Synced \d+ asset\(s\)/);
  });

  it('detected-but-undeclared is reported as suggested and NEVER provisioned', async () => {
    const out = captureOutput();
    const code = await runSyncSkills({
      argv: [],
      homeDir: home,
      skillsRoot,
      // Nothing declared — a detected client must not be auto-provisioned.
      detected: new Set(['claude-code']),
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(ExitCode.SUCCESS);

    expect(existsSync(claudeSkillPath(home, SUPPORTED_SKILLS[0]!))).toBe(false);
    expect(listEntries(home).length).toBe(0);
    // Reporting it is half the contract; the other half is saying what to DO.
    // A bare "nothing declared" is what sent every new user hunting through
    // docs for a config key, so the message must name the command.
    const said = out.stdoutLines.join('');
    expect(said).toMatch(/detected but not yet declared/i);
    expect(said).toMatch(/claude-code/);
    expect(said, 'the message must be actionable, not a dead end').toMatch(/mma setup/);
  });

  it('explicit --target forces provisioning regardless of the declared roster', async () => {
    const code = await runSyncSkills({
      argv: ['--target=codex'],
      homeDir: home,
      skillsRoot,
      // Nothing declared at all — the explicit --target still wins.
      stdout: () => true,
    });
    expect(code).toBe(ExitCode.SUCCESS);
    expect(existsSync(codexSkillPath(home, SUPPORTED_SKILLS[0]!))).toBe(true);
    expect(existsSync(claudeSkillPath(home, SUPPORTED_SKILLS[0]!))).toBe(false);
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
    expect(code).toBe(ExitCode.ERR_UNKNOWN_TARGET);
    expect(out.stderrLines.join('')).toMatch(/Unknown target 'cline'/);
  });

  it('--dry-run reports planned targets without touching disk or manifest', async () => {
    const out = captureOutput();
    const code = await runSyncSkills({
      argv: ['--target=claude-code', '--dry-run'],
      homeDir: home,
      skillsRoot,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(ExitCode.SUCCESS);
    expect(existsSync(claudeSkillPath(home, SUPPORTED_SKILLS[0]!))).toBe(false);
    expect(listEntries(home).length).toBe(0);
    expect(out.stdoutLines.join('')).toMatch(/Would sync/);
  });

  it('exits 0 with a friendly message when nothing is declared and no --target is given', async () => {
    const out = captureOutput();
    const code = await runSyncSkills({
      argv: [],
      homeDir: home,
      skillsRoot,
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(ExitCode.SUCCESS);
    expect(out.stdoutLines.join('')).toMatch(/No clients declared/);
  });

  it('--if-exists postinstall guard: exits 0 silently when no manifest exists yet', async () => {
    const emptyHome = mkdtempSync(path.join(tmpdir(), 'mma-sync-noman-'));
    try {
      const out = captureOutput();
      const code = await runSyncSkills({
        argv: [],
        homeDir: emptyHome,
        skillsRoot: '/nonexistent',
        ifExists: true,
        stdout: out.stdout,
        stderr: out.stderr,
      });
      expect(code).toBe(ExitCode.SUCCESS);
      expect(out.stdoutLines.length).toBe(0);
      expect(out.stderrLines.length).toBe(0);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('installs mma-flow as a command for claude-code, never as a skill; codex gets neither', async () => {
    const out1 = captureOutput();
    const code1 = await runSyncSkills({ argv: ['--target=claude-code'], homeDir: home, skillsRoot, stdout: out1.stdout, stderr: out1.stderr });
    expect(code1).toBe(ExitCode.SUCCESS);
    expect(existsSync(claudeCommandPath(home, 'mma-flow'))).toBe(true);
    expect(existsSync(path.join(home, '.claude', 'skills', 'mma-flow', 'SKILL.md'))).toBe(false);

    const out2 = captureOutput();
    const code2 = await runSyncSkills({ argv: ['--target=codex'], homeDir: home, skillsRoot, stdout: out2.stdout, stderr: out2.stderr });
    expect(code2).toBe(ExitCode.SUCCESS);
    expect(existsSync(path.join(home, '.codex', 'skills', 'mma-flow', 'SKILL.md'))).toBe(false);
  });
});
