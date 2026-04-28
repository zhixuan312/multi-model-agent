/**
 * tests/cli/codex-cli-writer.test.ts
 *
 * Unit tests for Codex CLI skill installs. Codex consumes native skills from
 * ~/.codex/skills/<skillName>/SKILL.md, so the writer must not collapse all
 * skills into a single AGENTS.md managed block.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';

import { installCodexCli, uninstallCodexCli } from '../../packages/server/src/install/codex-cli.js';

function makeFakeHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-codex-home-'));
}

function makeFakeSkillsRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-codex-skills-'));
}

function rmFakeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function skillDir(homeDir: string, skillName: string): string {
  return path.join(homeDir, '.codex', 'skills', skillName);
}

function skillFile(homeDir: string, skillName: string): string {
  return path.join(skillDir(homeDir, skillName), 'SKILL.md');
}

function agentsMd(homeDir: string): string {
  return path.join(homeDir, '.codex', 'AGENTS.md');
}

function populateShared(
  skillsRoot: string,
  files: Record<string, string>,
): void {
  const sharedDir = path.join(skillsRoot, '_shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = path.join(sharedDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr) as (
    chunk: unknown,
    ...args: unknown[]
  ) => boolean;
  process.stderr.write = (chunk: unknown, ..._args: unknown[]) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig as (
      chunk: unknown,
      ...args: unknown[]
    ) => boolean;
  }
  return chunks.join('');
}

describe('installCodexCli', () => {
  it('writes SKILL.md to <homeDir>/.codex/skills/<skillName>/SKILL.md', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      installCodexCli({
        skillName: 'mma-delegate',
        content: '# Delegate\n\nSkill content.',
        homeDir,
        skillsRoot,
      });

      expect(existsSync(skillFile(homeDir, 'mma-delegate'))).toBe(true);
      expect(readFileSync(skillFile(homeDir, 'mma-delegate'), 'utf-8')).toBe('# Delegate\n\nSkill content.');
      expect(existsSync(agentsMd(homeDir))).toBe(false);
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  it('keeps multiple installed skills as separate Codex skill directories', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      installCodexCli({
        skillName: 'mma-delegate',
        content: '# Delegate',
        homeDir,
        skillsRoot,
      });
      installCodexCli({
        skillName: 'mma-review',
        content: '# Review',
        homeDir,
        skillsRoot,
      });

      expect(readFileSync(skillFile(homeDir, 'mma-delegate'), 'utf-8')).toBe('# Delegate');
      expect(readFileSync(skillFile(homeDir, 'mma-review'), 'utf-8')).toBe('# Review');
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  it('does not modify user AGENTS.md when installing a skill', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
      fs.writeFileSync(agentsMd(homeDir), '# User agents\n\nKeep this.\n', 'utf-8');

      installCodexCli({
        skillName: 'mma-investigate',
        content: '# Investigate',
        homeDir,
        skillsRoot,
      });

      expect(readFileSync(agentsMd(homeDir), 'utf-8')).toBe('# User agents\n\nKeep this.\n');
      expect(readFileSync(skillFile(homeDir, 'mma-investigate'), 'utf-8')).toBe('# Investigate');
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  it('removes the legacy managed AGENTS.md block while preserving user content', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
      fs.writeFileSync(
        agentsMd(homeDir),
        '# User agents\n\n' +
        '<!-- multi-model-agent:BEGIN -->\n' +
        '# Old MMA block\n' +
        '<!-- multi-model-agent:END -->\n\n' +
        'Keep this.\n',
        'utf-8',
      );

      installCodexCli({
        skillName: 'mma-investigate',
        content: '# Investigate',
        homeDir,
        skillsRoot,
      });

      expect(readFileSync(agentsMd(homeDir), 'utf-8')).toBe('# User agents\n\nKeep this.\n');
      expect(readFileSync(skillFile(homeDir, 'mma-investigate'), 'utf-8')).toBe('# Investigate');
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  it('@include directive is inlined in the written SKILL.md', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      populateShared(skillsRoot, {
        'shared-snippet.md': '## Shared snippet\nThis is shared content.',
      });

      installCodexCli({
        skillName: 'mma-delegate',
        content: '# Skill\n\n@include _shared/shared-snippet.md\n\nEnd.',
        homeDir,
        skillsRoot,
      });

      const content = readFileSync(skillFile(homeDir, 'mma-delegate'), 'utf-8');
      expect(content).toContain('## Shared snippet');
      expect(content).toContain('This is shared content.');
      expect(content).not.toContain('@include _shared/shared-snippet.md');
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  it('warns to stderr when a shared file is missing during install', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      const stderr = captureStderr(() => {
        installCodexCli({
          skillName: 'mma-missing',
          content: '# Skill\n@include _shared/missing.md\nEnd.',
          homeDir,
          skillsRoot,
        });
      });

      expect(stderr).toContain('shared file not found');
      expect(stderr).toContain('Codex CLI skill writer');
      expect(readFileSync(skillFile(homeDir, 'mma-missing'), 'utf-8')).toBe('# Skill\nEnd.');
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });
});

describe('uninstallCodexCli', () => {
  it('removes only the requested Codex skill directory', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      installCodexCli({
        skillName: 'mma-delegate',
        content: '# Delegate',
        homeDir,
        skillsRoot,
      });
      installCodexCli({
        skillName: 'mma-review',
        content: '# Review',
        homeDir,
        skillsRoot,
      });

      uninstallCodexCli('mma-delegate', homeDir);

      expect(existsSync(skillFile(homeDir, 'mma-delegate'))).toBe(false);
      expect(readFileSync(skillFile(homeDir, 'mma-review'), 'utf-8')).toBe('# Review');
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  it('does not modify user AGENTS.md during uninstall', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
      fs.writeFileSync(agentsMd(homeDir), '# User agents\n', 'utf-8');
      installCodexCli({
        skillName: 'mma-investigate',
        content: '# Investigate',
        homeDir,
        skillsRoot,
      });

      uninstallCodexCli('mma-investigate', homeDir);

      expect(readFileSync(agentsMd(homeDir), 'utf-8')).toBe('# User agents\n');
      expect(existsSync(skillFile(homeDir, 'mma-investigate'))).toBe(false);
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  it('removes the legacy managed AGENTS.md block during uninstall migration cleanup', () => {
    const homeDir = makeFakeHome();
    try {
      fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
      fs.writeFileSync(
        agentsMd(homeDir),
        '# User agents\n\n' +
        '<!-- multi-model-agent:BEGIN -->\n' +
        '# Old MMA block\n' +
        '<!-- multi-model-agent:END -->\n\n',
        'utf-8',
      );

      uninstallCodexCli('mma-missing', homeDir);

      expect(readFileSync(agentsMd(homeDir), 'utf-8')).toBe('# User agents\n\n');
    } finally {
      rmFakeDir(homeDir);
    }
  });

  it('is a no-op when the requested skill directory does not exist', () => {
    const homeDir = makeFakeHome();
    try {
      expect(() => uninstallCodexCli('mma-missing', homeDir)).not.toThrow();
    } finally {
      rmFakeDir(homeDir);
    }
  });
});
