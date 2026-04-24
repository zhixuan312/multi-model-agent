/**
 * tests/cli/cursor-writer.test.ts
 *
 * Task 9.8: tests for the Cursor skill writer.
 * All tests use mkdtempSync for fake cwd and fake skillsRoot.
 * Never touch real .cursor/.
 */
import { describe, it, expect, afterEach } from 'vitest';
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
});

// ─── installCursor tests ────────────────────────────────────────────────────

describe('installCursor', () => {
  afterEach(() => {});

  it('writes the file when it does not exist', () => {
    const cwd = makeFakeCwd();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      const result = installCursor({
        content: '# Multi-Model Agent\n\nCursor skill content.',
        cwd,
        homeDir: makeFakeHome(),
        skillsRoot,
      });

      const dest = skillPath(cwd);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf-8')).toBe('# Multi-Model Agent\n\nCursor skill content.');
    } finally {
      cleanup(cwd);
    }
  });

  it('returns written: true and correct targetPath', () => {
    const cwd = makeFakeCwd();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      const result = installCursor({
        content: '# Test skill',
        cwd,
        homeDir: makeFakeHome(),
        skillsRoot,
      });

      expect(result.written).toBe(true);
      expect(result.targetPath).toBe(skillPath(cwd));
    } finally {
      cleanup(cwd);
    }
  });

  it('skips (returns written: false) when file exists and force is NOT set', () => {
    const cwd = makeFakeCwd();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      // First write
      installCursor({
        content: '# Original',
        cwd,
        homeDir: makeFakeHome(),
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
          homeDir: makeFakeHome(),
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
    }
  });

  it('overwrites when file exists and force: true', () => {
    const cwd = makeFakeCwd();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      // First write
      installCursor({
        content: '# Version 1',
        cwd,
        homeDir: makeFakeHome(),
        skillsRoot,
      });

      // Second write with force
      const result = installCursor({
        content: '# Version 2\nUpdated.',
        cwd,
        homeDir: makeFakeHome(),
        skillsRoot,
        force: true,
      });

      expect(result.written).toBe(true);
      expect(readFileSync(skillPath(cwd), 'utf-8')).toBe('# Version 2\nUpdated.');
    } finally {
      cleanup(cwd);
    }
  });

  it('@include directive is inlined in the written content', () => {
    const cwd = makeFakeCwd();
    const skillsRoot = makeFakeSkillsRoot({ 'endpoints.md': '## Endpoints\n- GET /api' });
    try {
      installCursor({
        content: '# Multi-Model Agent\n@include _shared/endpoints.md\n\nDone.',
        cwd,
        homeDir: makeFakeHome(),
        skillsRoot,
      });

      expect(readFileSync(skillPath(cwd), 'utf-8')).toBe(
        '# Multi-Model Agent\n## Endpoints\n- GET /api\n\nDone.',
      );
    } finally {
      cleanup(cwd);
    }
  });

  it('creates .cursor/rules/ directory if it does not exist', () => {
    const cwd = makeFakeCwd();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      expect(existsSync(path.join(cwd, '.cursor'))).toBe(false);

      installCursor({
        content: '# Skill',
        cwd,
        homeDir: makeFakeHome(),
        skillsRoot,
      });

      expect(existsSync(skillPath(cwd))).toBe(true);
    } finally {
      cleanup(cwd);
    }
  });
});

// ─── uninstallCursor tests ──────────────────────────────────────────────────

describe('uninstallCursor', () => {
  it('removes the skill file', () => {
    const cwd = makeFakeCwd();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      installCursor({
        content: '# Skill',
        cwd,
        homeDir: makeFakeHome(),
        skillsRoot,
      });

      expect(existsSync(skillPath(cwd))).toBe(true);

      uninstallCursor(cwd);

      expect(existsSync(skillPath(cwd))).toBe(false);
    } finally {
      cleanup(cwd);
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
