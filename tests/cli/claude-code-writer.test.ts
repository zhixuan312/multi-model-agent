/**
 * tests/cli/claude-code-writer.test.ts
 *
 * Task 9.5: integration tests for installClaudeCode() and uninstallClaudeCode().
 *
 * All tests use mkdtempSync for fake homeDir and fake skillsRoot so they
 * never touch the real ~/.claude directory.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  installClaudeCode,
  uninstallClaudeCode,
} from '../../packages/server/src/install/claude-code.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeFakeHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-claude-home-'));
}

function makeFakeSkillsRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-claude-skills-'));
}

function rmFakeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function skillDir(homeDir: string, skillName: string): string {
  return path.join(homeDir, '.claude', 'skills', skillName);
}

function skillFile(homeDir: string, skillName: string): string {
  return path.join(skillDir(homeDir, skillName), 'SKILL.md');
}

/** Populate <skillsRoot>/_shared/ with the given file→content map. */
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('installClaudeCode', () => {
  // ── 1. writes SKILL.md to correct path ───────────────────────────────────

  it('writes SKILL.md to <homeDir>/.claude/skills/<skillName>/SKILL.md', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      installClaudeCode({
        skillName: 'mma-review',
        content: '# My Skill\n\nSkill content here.',
        homeDir,
        skillsRoot,
      });

      const file = skillFile(homeDir, 'mma-review');
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('# My Skill\n\nSkill content here.');
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  it('creates intermediate .claude/skills/<skillName>/ directories', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      expect(existsSync(path.join(homeDir, '.claude'))).toBe(false);

      installClaudeCode({
        skillName: 'test-skill',
        content: '# Skill',
        homeDir,
        skillsRoot,
      });

      expect(existsSync(skillFile(homeDir, 'test-skill'))).toBe(true);
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  // ── 2. @include directive is inlined ─────────────────────────────────────

  it('@include directive is inlined (directive line replaced with file content)', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    populateShared(skillsRoot, { 'endpoints.md': '## Endpoints\n- GET /api\n- POST /api' });
    try {
      installClaudeCode({
        skillName: 'api-skill',
        content: '# API Skill\n@include _shared/endpoints.md\n\nDone.',
        homeDir,
        skillsRoot,
      });

      const content = readFileSync(skillFile(homeDir, 'api-skill'), 'utf-8');
      expect(content).toBe('# API Skill\n## Endpoints\n- GET /api\n- POST /api\n\nDone.');
      // The @include directive line itself must NOT appear in output
      expect(content).not.toContain('@include _shared/endpoints.md');
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  // ── 3. Multiple @include directives are all inlined ───────────────────────

  it('multiple @include directives in one file are all inlined', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    populateShared(skillsRoot, {
      'header.md': '# Shared Header',
      'footer.md': '---\nShared Footer',
    });
    try {
      installClaudeCode({
        skillName: 'multi-skill',
        content: '@include _shared/header.md\n\nBody content.\n\n@include _shared/footer.md',
        homeDir,
        skillsRoot,
      });

      const content = readFileSync(skillFile(homeDir, 'multi-skill'), 'utf-8');
      expect(content).toBe('# Shared Header\n\nBody content.\n\n---\nShared Footer');
      expect(content).not.toContain('@include _shared/header.md');
      expect(content).not.toContain('@include _shared/footer.md');
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  // ── 4. Missing shared file → logs warning to stderr, write continues ─────

  it('logs warning to stderr when shared file is missing, write continues', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot(); // no shared files
    try {
      const stderrLines: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: string) => {
        stderrLines.push(chunk.toString());
        return true;
      };
      try {
        installClaudeCode({
          skillName: 'mma-missing',
          content: '# Skill\n@include _shared/nonexistent.md\nEnd.',
          homeDir,
          skillsRoot,
        });

        const stderrOutput = stderrLines.join('');
        expect(stderrOutput).toContain('Warning');
        expect(stderrOutput).toContain('shared file not found');
        expect(stderrOutput).toContain('nonexistent.md');

        // Include line is dropped, rest is written
        const fileContent = readFileSync(skillFile(homeDir, 'mma-missing'), 'utf-8');
        expect(fileContent).toBe('# Skill\nEnd.');
        expect(fileContent).not.toContain('@include _shared/nonexistent.md');
      } finally {
        process.stderr.write = orig;
      }
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });
});

describe('uninstallClaudeCode', () => {
  // ── 5. removes the skill directory ───────────────────────────────────────

  it('removes the skill directory recursively', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      installClaudeCode({
        skillName: 'to-uninstall',
        content: '# Skill to remove',
        homeDir,
        skillsRoot,
      });

      expect(existsSync(skillDir(homeDir, 'to-uninstall'))).toBe(true);

      uninstallClaudeCode('to-uninstall', homeDir);

      expect(existsSync(skillDir(homeDir, 'to-uninstall'))).toBe(false);
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  // ── 6. is a no-op when directory does not exist ──────────────────────────

  it('is a no-op (no error) when directory does not exist', () => {
    const homeDir = makeFakeHome();
    try {
      // Should not throw
      expect(() => uninstallClaudeCode('nonexistent-skill', homeDir)).not.toThrow();

      // Should also not throw when .claude dir doesn't exist
      expect(existsSync(path.join(homeDir, '.claude'))).toBe(false);
      expect(() => uninstallClaudeCode('nonexistent-skill', homeDir)).not.toThrow();
    } finally {
      rmFakeDir(homeDir);
    }
  });
});
