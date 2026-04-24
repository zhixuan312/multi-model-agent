/**
 * tests/cli/cursor-writer.test.ts
 *
 * Task 9.8: tests for the Cursor skill writer.
 * All tests use mkdtempSync for fake cwd and fake skillsRoot.
 * Never touch real .cursor/.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { installCursor, uninstallCursor, inlineIncludes } from '../../packages/server/src/install/cursor.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFakeCwd(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-cursor-cwd-'));
}

function makeFakeHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-cursor-home-'));
}

function makeFakeSkillsRoot(sharedFiles: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mmagent-cursor-skills-'));
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

function skillPath(cwd: string): string {
  return path.join(cwd, '.cursor', 'rules', 'multi-model-agent.mdc');
}

// ─── inlineIncludes tests ───────────────────────────────────────────────────

describe('inlineIncludes', () => {
  it('returns content unchanged when no directives present', () => {
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      const content = '# Cursor Skill\n\nThis is a skill.';
      expect(inlineIncludes(content, skillsRoot)).toBe('# Cursor Skill\n\nThis is a skill.');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('inlines a single @include directive', () => {
    const skillsRoot = makeFakeSkillsRoot({ 'header.md': '# Shared Header' });
    try {
      const content = '@include _shared/header.md\n\n## Body\nSome content.';
      const result = inlineIncludes(content, skillsRoot);
      expect(result).toBe('# Shared Header\n\n## Body\nSome content.');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('inlines multiple @include directives', () => {
    const skillsRoot = makeFakeSkillsRoot({
      'header.md': '# Header',
      'footer.md': '---\nFooter',
    });
    try {
      const content = '@include _shared/header.md\n\nBody.\n\n@include _shared/footer.md';
      const result = inlineIncludes(content, skillsRoot);
      expect(result).toBe('# Header\n\nBody.\n\n---\nFooter');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('logs warning to stderr for missing shared file and drops the line', () => {
    const skillsRoot = makeFakeSkillsRoot({}); // no shared files
    try {
      const content = '# Skill\n@include _shared/nonexistent.md\nDone.';
      const result = inlineIncludes(content, skillsRoot);
      // Include line is removed; rest is preserved
      expect(result).toBe('# Skill\nDone.');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('preserves lines that do not start with @include', () => {
    const skillsRoot = makeFakeSkillsRoot({ 'common.md': 'Shared content.' });
    try {
      const content = '# Skill\n@include _shared/common.md\nNot a directive: @include something.';
      const result = inlineIncludes(content, skillsRoot);
      expect(result).toBe('# Skill\nShared content.\nNot a directive: @include something.');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('rejects path traversal attempts via @include _shared/../<path>', () => {
    const skillsRoot = makeFakeSkillsRoot({ 'secret.md': 'SECRET' });
    try {
      // Attempt to escape _shared via traversal
      const content = '# Skill\n@include _shared/../secret.md\nDone.';
      const result = inlineIncludes(content, skillsRoot);
      // The directive line should be dropped, secret should NOT appear
      expect(result).toBe('# Skill\nDone.');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('rejects @include paths not starting with _shared/', () => {
    const skillsRoot = makeFakeSkillsRoot({ 'other.md': 'OTHER' });
    try {
      const content = '# Skill\n@include other.md\nDone.';
      const result = inlineIncludes(content, skillsRoot);
      // Non-_shared/ paths are rejected; line is dropped
      expect(result).toBe('# Skill\nDone.');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('inlines nested _shared/... paths correctly', () => {
    // Test that _shared/foo/bar.md resolves to skillsRoot/_shared/foo/bar.md
    const skillsRoot = makeFakeSkillsRoot({
      'foo/bar.md': '## Nested Section',
    });
    try {
      const content = '@include _shared/foo/bar.md\n\nMore content.';
      const result = inlineIncludes(content, skillsRoot);
      expect(result).toBe('## Nested Section\n\nMore content.');
    } finally {
      cleanup(skillsRoot);
    }
  });
});

// ─── installCursor tests ────────────────────────────────────────────────────

describe('installCursor', () => {
  it('writes the file when it does not exist', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      const result = installCursor({
        content: '# Multi-Model Agent\n\nCursor skill content.',
        cwd,
        homeDir,
        skillsRoot,
      });

      const dest = skillPath(cwd);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf-8')).toBe('# Multi-Model Agent\n\nCursor skill content.');
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('returns written: true and correct targetPath', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      const result = installCursor({
        content: '# Test skill',
        cwd,
        homeDir,
        skillsRoot,
      });

      expect(result.written).toBe(true);
      expect(result.targetPath).toBe(skillPath(cwd));
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('skips (returns written: false) when file exists and force is NOT set', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      // First write
      installCursor({
        content: '# Original',
        cwd,
        homeDir,
        skillsRoot,
      });

      // Second write without force
      const stderrLines: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: string) => {
        stderrLines.push(chunk);
        return true;
      };
      try {
        const result = installCursor({
          content: '# Updated — should not appear',
          cwd,
          homeDir,
          skillsRoot,
        });

        expect(result.written).toBe(false);
        expect(result.targetPath).toBe(skillPath(cwd));

        // Original content preserved
        expect(readFileSync(skillPath(cwd), 'utf-8')).toBe('# Original');

        // Warning was emitted to stderr
        const warning = stderrLines.join('');
        expect(warning).toContain('Warning');
        expect(warning).toContain('already exists');
      } finally {
        process.stderr.write = orig;
      }
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('overwrites when file exists and force: true', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      // First write
      installCursor({
        content: '# Version 1',
        cwd,
        homeDir,
        skillsRoot,
      });

      // Second write with force
      const result = installCursor({
        content: '# Version 2\nUpdated.',
        cwd,
        homeDir,
        skillsRoot,
        force: true,
      });

      expect(result.written).toBe(true);
      expect(readFileSync(skillPath(cwd), 'utf-8')).toBe('# Version 2\nUpdated.');
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('@include directive is inlined in the written content', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({ 'endpoints.md': '## Endpoints\n- GET /api' });
    try {
      installCursor({
        content: '# Multi-Model Agent\n@include _shared/endpoints.md\n\nDone.',
        cwd,
        homeDir,
        skillsRoot,
      });

      expect(readFileSync(skillPath(cwd), 'utf-8')).toBe(
        '# Multi-Model Agent\n## Endpoints\n- GET /api\n\nDone.',
      );
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('creates .cursor/rules/ directory if it does not exist', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      expect(existsSync(path.join(cwd, '.cursor'))).toBe(false);

      installCursor({
        content: '# Skill',
        cwd,
        homeDir,
        skillsRoot,
      });

      expect(existsSync(skillPath(cwd))).toBe(true);
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('logs warning to stderr for missing shared file via installCursor', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({}); // no shared files
    try {
      const stderrLines: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: string) => {
        stderrLines.push(chunk);
        return true;
      };
      try {
        installCursor({
          content: '# Skill\n@include _shared/nonexistent.md\nDone.',
          cwd,
          homeDir,
          skillsRoot,
        });

        const stderrOutput = stderrLines.join('');
        expect(stderrOutput).toContain('Warning');
        expect(stderrOutput).toContain('shared file not found');
        expect(stderrOutput).toContain('nonexistent.md');

        // Include line should be dropped, rest preserved
        expect(readFileSync(skillPath(cwd), 'utf-8')).toBe('# Skill\nDone.');
      } finally {
        process.stderr.write = orig;
      }
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('rejects path traversal in @include via installCursor', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({ 'secret.md': 'SECRET' });
    try {
      const stderrLines: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: string) => {
        stderrLines.push(chunk);
        return true;
      };
      try {
        installCursor({
          content: '# Skill\n@include _shared/../secret.md\nDone.',
          cwd,
          homeDir,
          skillsRoot,
        });

        const stderrOutput = stderrLines.join('');
        expect(stderrOutput).toContain('Warning');
        expect(stderrOutput).toContain('path traversal');

        // Traversal line should be dropped, rest preserved
        expect(readFileSync(skillPath(cwd), 'utf-8')).toBe('# Skill\nDone.');
      } finally {
        process.stderr.write = orig;
      }
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('inlines nested _shared/... paths via installCursor', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({
      'foo/bar.md': '## Nested Section',
    });
    try {
      installCursor({
        content: '@include _shared/foo/bar.md\n\nMore content.',
        cwd,
        homeDir,
        skillsRoot,
      });

      expect(readFileSync(skillPath(cwd), 'utf-8')).toBe(
        '## Nested Section\n\nMore content.',
      );
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });
});

// ─── uninstallCursor tests ──────────────────────────────────────────────────

describe('uninstallCursor', () => {
  it('removes the skill file', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      installCursor({
        content: '# Skill',
        cwd,
        homeDir,
        skillsRoot,
      });

      expect(existsSync(skillPath(cwd))).toBe(true);

      uninstallCursor(cwd);

      expect(existsSync(skillPath(cwd))).toBe(false);
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('is a no-op when file does not exist', () => {
    const cwd = makeFakeCwd();
    try {
      // Should not throw
      expect(() => uninstallCursor(cwd)).not.toThrow();

      // Should also not throw when .cursor dir doesn't exist
      expect(existsSync(path.join(cwd, '.cursor'))).toBe(false);
      expect(() => uninstallCursor(cwd)).not.toThrow();
    } finally {
      cleanup(cwd);
    }
  });
});