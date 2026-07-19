import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runSyncSkills } from '../../packages/server/src/cli/sync-skills.js';
import {
  SUPPORTED_COMMANDS,
  SUPPORTED_SKILLS,
  readCommandContent,
} from '../../packages/server/src/skill-install/discover.js';

function makeFakeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'mma-breakout-home-'));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  return home;
}

function removeFakeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function writeFakeSkill(root: string, name: string, version: string): void {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\nversion: ${version}\ndescription: fixture\nwhen_to_use: fixture\n---\n# /${name}\n`,
    'utf8',
  );
}

function makeFakeSkillsRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mma-breakout-skills-'));
  for (const skill of SUPPORTED_SKILLS) writeFakeSkill(root, skill, '4.0.2');
  writeFakeSkill(root, 'mma-flow', '4.0.2');
  writeFakeSkill(root, 'mma-breakout', '4.0.2');
  return root;
}

describe('mma-breakout command install surface', () => {
  const tmpPaths: string[] = [];

  afterEach(() => {
    for (const dir of tmpPaths.splice(0)) removeFakeDir(dir);
  });

  it('registers mma-breakout as a command and exposes readCommandContent', () => {
    expect(SUPPORTED_COMMANDS).toContain('mma-breakout');
    expect(SUPPORTED_SKILLS).not.toContain('mma-breakout');

    const content = readCommandContent('mma-breakout');
    expect(content).toBeTruthy();
    expect(content).toContain('name: mma-breakout');
    expect(content).toContain('# /mma-breakout');
  });

  it('installs mma-breakout into ~/.claude/commands and not ~/.claude/skills', async () => {
    const home = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    tmpPaths.push(home, skillsRoot);

    const code = await runSyncSkills({
      argv: ['--target=claude-code'],
      homeDir: home,
      skillsRoot,
      stdout: () => true,
      stderr: () => true,
    });

    expect(code).toBe(0);
    expect(existsSync(path.join(home, '.claude', 'commands', 'mma-breakout.md'))).toBe(true);
    expect(existsSync(path.join(home, '.claude', 'skills', 'mma-breakout', 'SKILL.md'))).toBe(false);
    expect(readFileSync(path.join(home, '.claude', 'commands', 'mma-breakout.md'), 'utf8')).toContain('# /mma-breakout');
  });
});
