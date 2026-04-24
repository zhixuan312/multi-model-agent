/**
 * tests/cli/update-skills.test.ts — `mmagent update-skills` subcommand.
 *
 * Uses a sandbox homeDir + skillsRoot so we don't touch the real manifest
 * or the shipped SKILL.md files.
 */
import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runUpdateSkills } from '../../packages/server/src/cli/update-skills.js';
import { appendEntry, listEntries } from '../../packages/server/src/install/manifest.js';

function mkSandbox(): { home: string; skillsRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'mmagent-update-skills-'));
  const home = join(root, 'home');
  const skillsRoot = join(root, 'skills');
  mkdirSync(home, { recursive: true });
  mkdirSync(skillsRoot, { recursive: true });
  // Ensure detectClients sees claude-code installed.
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  return { home, skillsRoot };
}

function writeSkill(skillsRoot: string, name: string, version: string): void {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  const content = `---
name: ${name}
description: test skill
when_to_use: tests
version: "${version}"
---

# ${name}

Body.
`;
  writeFileSync(join(dir, 'SKILL.md'), content);
}

function cap() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    stdoutFn: (s: string) => { stdout.push(s); return true; },
    stderrFn: (s: string) => { stderr.push(s); return true; },
  };
}

describe('mmagent update-skills', () => {
  it('--if-exists with no manifest returns 0 silently', async () => {
    const { home, skillsRoot } = mkSandbox();
    try {
      const c = cap();
      const code = await runUpdateSkills({
        homeDir: home,
        skillsRoot,
        ifExists: true,
        stdout: c.stdoutFn,
        stderr: c.stderrFn,
      });
      expect(code).toBe(0);
      expect(c.stdout.join('')).toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });

  it('re-copies every manifest entry from skillsRoot into claude-code target', async () => {
    const { home, skillsRoot } = mkSandbox();
    try {
      writeSkill(skillsRoot, 'mma-delegate', '3.1.0');
      // Seed manifest with the older skillVersion
      appendEntry('mma-delegate', '3.0.0', ['claude-code'], home);

      const c = cap();
      const code = await runUpdateSkills({
        homeDir: home,
        skillsRoot,
        stdout: c.stdoutFn,
        stderr: c.stderrFn,
      });
      expect(code).toBe(0);

      const target = join(home, '.claude', 'skills', 'mma-delegate', 'SKILL.md');
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, 'utf8')).toContain('version: "3.1.0"');

      // Manifest bumped to new skillVersion
      expect(listEntries(home)[0]!.skillVersion).toBe('3.1.0');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });

  it('--dry-run logs planned changes and leaves manifest + target unchanged', async () => {
    const { home, skillsRoot } = mkSandbox();
    try {
      writeSkill(skillsRoot, 'mma-delegate', '3.1.0');
      appendEntry('mma-delegate', '3.0.0', ['claude-code'], home);

      const c = cap();
      const code = await runUpdateSkills({
        homeDir: home,
        skillsRoot,
        dryRun: true,
        stdout: c.stdoutFn,
        stderr: c.stderrFn,
      });
      expect(code).toBe(0);
      expect(c.stdout.join('')).toMatch(/Would update: mma-delegate → claude-code \(3\.0\.0 → 3\.1\.0\)/);
      expect(listEntries(home)[0]!.skillVersion).toBe('3.0.0'); // unchanged
      expect(existsSync(join(home, '.claude', 'skills', 'mma-delegate', 'SKILL.md'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });

  it('removes manifest entries for skills no longer shipped', async () => {
    const { home, skillsRoot } = mkSandbox();
    try {
      // Write mma-delegate but NOT mma-gone
      writeSkill(skillsRoot, 'mma-delegate', '3.1.0');
      appendEntry('mma-delegate', '3.0.0', ['claude-code'], home);
      appendEntry('mma-gone', '3.0.0', ['claude-code'], home);

      const c = cap();
      const code = await runUpdateSkills({
        homeDir: home,
        skillsRoot,
        stdout: c.stdoutFn,
        stderr: c.stderrFn,
      });
      expect(code).toBe(0);

      const entries = listEntries(home);
      expect(entries.map((e) => e.name)).toEqual(['mma-delegate']);
      expect(c.stdout.join('')).toMatch(/Removed: mma-gone/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });

  it('--json emits structured summary on stdout', async () => {
    const { home, skillsRoot } = mkSandbox();
    try {
      writeSkill(skillsRoot, 'mma-delegate', '3.1.0');
      appendEntry('mma-delegate', '3.0.0', ['claude-code'], home);

      const c = cap();
      const code = await runUpdateSkills({
        homeDir: home,
        skillsRoot,
        json: true,
        stdout: c.stdoutFn,
        stderr: c.stderrFn,
      });
      expect(code).toBe(0);
      const body = JSON.parse(c.stdout.join(''));
      expect(body.updated).toEqual(['mma-delegate']);
      expect(body.removed).toEqual([]);
      expect(body.errors).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });

  it('returns exit code 2 when manifest has a future version (absent --best-effort)', async () => {
    const { home, skillsRoot } = mkSandbox();
    try {
      mkdirSync(join(home, '.multi-model'), { recursive: true });
      writeFileSync(
        join(home, '.multi-model', 'install-manifest.json'),
        JSON.stringify({ version: 99, entries: [] }),
      );
      const c = cap();
      const code = await runUpdateSkills({
        homeDir: home,
        skillsRoot,
        stdout: c.stdoutFn,
        stderr: c.stderrFn,
      });
      expect(code).toBe(2);
      expect(c.stderr.join('')).toMatch(/newer mmagent/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });

  it('--best-effort swallows FutureManifestError and returns 0', async () => {
    const { home, skillsRoot } = mkSandbox();
    try {
      mkdirSync(join(home, '.multi-model'), { recursive: true });
      writeFileSync(
        join(home, '.multi-model', 'install-manifest.json'),
        JSON.stringify({ version: 99, entries: [] }),
      );
      const c = cap();
      const code = await runUpdateSkills({
        homeDir: home,
        skillsRoot,
        bestEffort: true,
        stdout: c.stdoutFn,
        stderr: c.stderrFn,
      });
      expect(code).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });
});
