/**
 * tests/cli/claude-code-writer.test.ts
 *
 * Task 9.5: unit tests for installClaudeCode() and uninstallClaudeCode().
 *
 * All tests use mkdtempSync for fake homeDir and fake skillsRoot so they
 * never touch the real ~/.claude directory.
 *
 * Test cases (6 total, matching the brief):
 *   1. installClaudeCode writes SKILL.md to correct path
 *   2. @include directive is inlined (directive line replaced with file content)
 *   3. Multiple @include directives in one file are all inlined
 *   4. Missing shared file → logs warning to stderr, write continues (include line removed)
 *   5. uninstallClaudeCode removes the skill directory
 *   6. uninstallClaudeCode is a no-op when directory does not exist
 *
 * Additional edge-case coverage:
 *   - Path traversal via @include is rejected
 *   - Nested shared paths under _shared/subdir/ are resolved correctly
 *   - Malformed include lines (non-_shared/ paths) are rejected with a warning
 *
 * @module
 */
import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
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

/** Populate <skillsRoot>/_shared/ with the given relPath→content map. */
function populateShared(
  skillsRoot: string,
  files: Record<string, string>,
): void {
  const sharedDir = path.join(skillsRoot, '_shared');
  mkdirSync(sharedDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = path.join(sharedDir, relPath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
  }
}

/**
 * Capture whatever `process.stderr.write` receives as a string array.
 * Uses Node's overload signature: `write(chunk: unknown, ...args: unknown[])`.
 */
function captureStderr(
  fn: () => void,
): { stderrOutput: string } {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr) as (
    chunk: unknown,
    ...args: unknown[]
  ) => boolean;
  process.stderr.write = (
    chunk: unknown,
    ..._args: unknown[]
  ) => {
    lines.push(String(chunk));
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
  return { stderrOutput: lines.join('') };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('installClaudeCode', () => {
  // ── 1. writes SKILL.md to correct path ───────────────────────────────────

  it('writes SKILL.md to <homeDir>/.claude/skills/<skillName>/SKILL.md', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      // Confirm intermediate directories do not exist yet
      expect(existsSync(path.join(homeDir, '.claude'))).toBe(false);

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
    const skillsRoot = makeFakeSkillsRoot(); // no shared files created
    try {
      const { stderrOutput } = captureStderr(() => {
        installClaudeCode({
          skillName: 'mma-missing',
          content: '# Skill\n@include _shared/nonexistent.md\nEnd.',
          homeDir,
          skillsRoot,
        });
      });

      expect(stderrOutput).toContain('Warning');
      expect(stderrOutput).toContain('shared file not found');
      expect(stderrOutput).toContain('nonexistent.md');

      // Include line is dropped, remaining content is written
      const fileContent = readFileSync(skillFile(homeDir, 'mma-missing'), 'utf-8');
      expect(fileContent).toBe('# Skill\nEnd.');
      expect(fileContent).not.toContain('@include _shared/nonexistent.md');
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  // ── Edge: Path traversal in @include is rejected ─────────────────────────

  it('path traversal via @include _shared/../x.md is rejected', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    // Create a file outside _shared/ to make the traversal target concrete
    writeFileSync(path.join(skillsRoot, 'outside.md'), 'SECRET', 'utf-8');
    try {
      const { stderrOutput } = captureStderr(() => {
        installClaudeCode({
          skillName: 'traversal-test',
          content: '# Skill\n@include _shared/../outside.md\nEnd.',
          homeDir,
          skillsRoot,
        });
      });

      expect(stderrOutput).toContain('Warning');
      expect(stderrOutput).toContain('path traversal');

      // Include line is dropped; remaining content written
      const fileContent = readFileSync(skillFile(homeDir, 'traversal-test'), 'utf-8');
      expect(fileContent).toBe('# Skill\nEnd.');
      expect(fileContent).not.toContain('SECRET');
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  // ── Edge: Nested shared paths under _shared/subdir/ are resolved ───────────

  it('nested shared paths under _shared/subdir/ are resolved correctly', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    populateShared(skillsRoot, {
      'subdir/deep.md': '> nested shared content',
    });
    try {
      installClaudeCode({
        skillName: 'nested-skill',
        content: '# Skill\n@include _shared/subdir/deep.md\nEnd.',
        homeDir,
        skillsRoot,
      });

      const fileContent = readFileSync(skillFile(homeDir, 'nested-skill'), 'utf-8');
      expect(fileContent).toBe('# Skill\n> nested shared content\nEnd.');
      expect(fileContent).not.toContain('@include');
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });

  // ── Edge: Malformed include lines (non-_shared/ paths) are rejected ─────────

  it('malformed @include lines (non-_shared/ paths) are rejected with a warning', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      const { stderrOutput } = captureStderr(() => {
        installClaudeCode({
          skillName: 'malformed-include',
          content: '# Skill\n@include /absolute/path.md\nEnd.',
          homeDir,
          skillsRoot,
        });
      });

      expect(stderrOutput).toContain('Warning');
      expect(stderrOutput).toContain('must start with "_shared/"');

      // Include line is dropped; remaining content written
      const fileContent = readFileSync(skillFile(homeDir, 'malformed-include'), 'utf-8');
      expect(fileContent).toBe('# Skill\nEnd.');
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
      expect(() =>
        uninstallClaudeCode('nonexistent-skill', homeDir),
      ).not.toThrow();

      // Should also not throw when .claude dir itself doesn't exist
      expect(existsSync(path.join(homeDir, '.claude'))).toBe(false);
      expect(() =>
        uninstallClaudeCode('nonexistent-skill', homeDir),
      ).not.toThrow();
    } finally {
      rmFakeDir(homeDir);
    }
  });

  // ── Edge: Path traversal via skillName is a no-op ─────────────────────────

  it('path traversal via skillName is a no-op (does not escape skills dir)', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      // Install a legitimate skill
      installClaudeCode({
        skillName: 'legitimate-skill',
        content: '# Legitimate',
        homeDir,
        skillsRoot,
      });
      const legitimatePath = skillDir(homeDir, 'legitimate-skill');
      expect(existsSync(legitimatePath)).toBe(true);

      // Attempt a traversal attack — must not remove legitimate-skill
      uninstallClaudeCode('../legitimate-skill', homeDir);
      expect(existsSync(legitimatePath)).toBe(true);
    } finally {
      rmFakeDir(homeDir);
      rmFakeDir(skillsRoot);
    }
  });
});
