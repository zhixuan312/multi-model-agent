/**
 * tests/cli/claude-code-writer.test.ts
 *
 * Task 9.5: tests for the Claude Code skill writer.
 * All tests use mkdtempSync for fake homeDir and fake skillsRoot.
 * Never touch real ~/.claude.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  installClaudeCode,
  uninstallClaudeCode,
  inlineIncludes,
} from '../../packages/server/src/install/claude-code.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFakeHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-claude-code-home-'));
}

function makeFakeSkillsRoot(sharedFiles: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mmagent-claude-code-skills-'));
  // Shared files are at skillsRoot/_shared/<file> so @include _shared/<file> resolves correctly.
  const sharedDir = path.join(root, '_shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  for (const [relPath, content] of Object.entries(sharedFiles)) {
    const filePath = path.join(sharedDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  return root;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function skillPath(homeDir: string, skillName: string): string {
  return path.join(homeDir, '.claude', 'skills', skillName, 'SKILL.md');
}

// ─── Capture stderr ──────────────────────────────────────────────────────────

/**
 * Wraps process.stderr.write and captures all written chunks into `chunks`.
 * Returns a restore function.
 */
function captureStderr(chunks: string[]): () => void {
  const orig = process.stderr.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = function (chunk: unknown, ..._args: unknown[]) {
    if (typeof chunk === 'string') {
      chunks.push(chunk);
    }
    return orig(chunk as string);
  };
  return function restore() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = orig;
  };
}

// ─── inlineIncludes edge cases ───────────────────────────────────────────────

describe('inlineIncludes edge cases', () => {
  it('drops directive when path does not start with _shared/', () => {
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      const content = '# Skill\n@include docs/include.md\nDone.';
      const result = inlineIncludes('test-skill', content, skillsRoot);
      // Directive line should be dropped
      expect(result).toBe('# Skill\nDone.');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('drops directive when path traversal is attempted', () => {
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      const content = '# Skill\n@include _shared/../../secret.md';
      const result = inlineIncludes('test-skill', content, skillsRoot);
      expect(result).toBe('# Skill');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('drops directive for absolute-looking paths', () => {
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      const content = '# Skill\n@include /etc/passwd';
      const result = inlineIncludes('test-skill', content, skillsRoot);
      expect(result).toBe('# Skill');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('handles directive at end-of-file without trailing newline', () => {
    const skillsRoot = makeFakeSkillsRoot({ 'footer.md': 'Footer content' });
    try {
      const content = '# Skill\n@include _shared/footer.md'; // no trailing newline
      const result = inlineIncludes('test-skill', content, skillsRoot);
      expect(result).toBe('# Skill\nFooter content');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('re-throws non-ENOENT errors', () => {
    const skillsRoot = makeFakeSkillsRoot({});
    // Create a directory where a file is expected
    const filePath = path.join(skillsRoot, '_shared', 'should-be-dir');
    fs.mkdirSync(filePath, { recursive: true });
    try {
      const content = '# Skill\n@include _shared/should-be-dir';
      expect(() => inlineIncludes('test-skill', content, skillsRoot)).toThrow();
    } finally {
      cleanup(skillsRoot);
    }
  });
});

// ─── installClaudeCode tests ───────────────────────────────────────────────

describe('installClaudeCode', () => {
  it('writes SKILL.md to the correct path', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      installClaudeCode({
        skillName: 'mma-delegate',
        content: '# mma-delegate skill',
        homeDir,
        skillsRoot,
      });

      const dest = skillPath(homeDir, 'mma-delegate');
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf-8')).toBe('# mma-delegate skill');
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('inlines @include directive before writing', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({ 'endpoints.md': '## Endpoints\n- GET /' });
    try {
      installClaudeCode({
        skillName: 'mma-audit',
        content: '# mma-audit\n@include _shared/endpoints.md',
        homeDir,
        skillsRoot,
      });

      const dest = skillPath(homeDir, 'mma-audit');
      expect(readFileSync(dest, 'utf-8')).toBe('# mma-audit\n## Endpoints\n- GET /');
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('inlines multiple @include directives before writing', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({
      'header.md': '# Skill',
      'footer.md': '---',
    });
    try {
      installClaudeCode({
        skillName: 'multi-model-agent',
        content: '@include _shared/header.md\n\nBody.\n\n@include _shared/footer.md',
        homeDir,
        skillsRoot,
      });

      const dest = skillPath(homeDir, 'multi-model-agent');
      expect(readFileSync(dest, 'utf-8')).toBe('# Skill\n\nBody.\n\n---');
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('logs warning to stderr when shared file is missing and removes line', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({}); // no shared files
    const stderrChunks: string[] = [];
    const restore = captureStderr(stderrChunks);
    try {
      installClaudeCode({
        skillName: 'mma-review',
        content: '# Review\n@include _shared/missing.md\nDone.',
        homeDir,
        skillsRoot,
      });

      const dest = skillPath(homeDir, 'mma-review');
      // Include directive removed; Done. preserved
      expect(readFileSync(dest, 'utf-8')).toBe('# Review\nDone.');

      // Warning was logged
      const warning = stderrChunks.join('');
      expect(warning).toContain('Warning');
      expect(warning).toContain('missing.md');
    } finally {
      restore();
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('rejects skillName with path traversal', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      expect(() =>
        installClaudeCode({
          skillName: '../otherdir',
          content: '# Hack',
          homeDir,
          skillsRoot,
        }),
      ).toThrow(/path traversal not allowed/);
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('rejects skillName with absolute path', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      expect(() =>
        installClaudeCode({
          skillName: '/etc/passwd',
          content: '# Hack',
          homeDir,
          skillsRoot,
        }),
      ).toThrow(/path traversal not allowed/);
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('rejects empty skillName', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      expect(() =>
        installClaudeCode({
          skillName: '',
          content: '# Hack',
          homeDir,
          skillsRoot,
        }),
      ).toThrow(/skillName must be a non-empty string/);
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });
});

// ─── uninstallClaudeCode tests ─────────────────────────────────────────────

describe('uninstallClaudeCode', () => {
  it('removes the skill directory', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      installClaudeCode({
        skillName: 'mma-delegate',
        content: '# delegate',
        homeDir,
        skillsRoot,
      });

      const dest = skillPath(homeDir, 'mma-delegate');
      expect(existsSync(dest)).toBe(true);

      uninstallClaudeCode('mma-delegate', homeDir);

      expect(existsSync(dest)).toBe(false);
      // Parent .claude dir should survive
      expect(existsSync(path.join(homeDir, '.claude'))).toBe(true);
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('is a no-op when directory does not exist', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      // Should not throw
      expect(() => uninstallClaudeCode('never-installed', homeDir)).not.toThrow();

      // Should also not crash when .claude doesn't exist
      expect(existsSync(path.join(homeDir, '.claude'))).toBe(false);
      expect(() => uninstallClaudeCode('never-installed', homeDir)).not.toThrow();
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('rejects skillName with path traversal', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      expect(() => uninstallClaudeCode('../otherdir', homeDir)).toThrow(
        /path traversal not allowed/,
      );
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('rejects empty skillName', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      expect(() => uninstallClaudeCode('', homeDir)).toThrow(
        /skillName must be a non-empty string/,
      );
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });
});