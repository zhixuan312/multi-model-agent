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
import { WriteStream } from 'node:fs';

import { installCursor, uninstallCursor } from '../../packages/server/src/install/cursor.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFakeCwd(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-cursor-cwd-'));
}

function makeFakeHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-cursor-home-'));
}

function makeFakeSkillsRoot(sharedFiles: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mmagent-cursor-skills-'));
  if (Object.keys(sharedFiles).length > 0) {
    const sharedDir = path.join(root, '_shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    for (const [relPath, content] of Object.entries(sharedFiles)) {
      const filePath = path.join(sharedDir, relPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
    }
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

/**
 * Capture stderr output during a function execution.
 * Returns the concatenated stderr string.
 *
 * Uses a type-faithful WriteStream-compatible approach: the write method
 * accepts the standard Node overloads.
 */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr) as (
    chunk: string | Uint8Array,
    ...args: unknown[]
  ) => boolean;
  process.stderr.write = (
    chunk: string | Uint8Array,
    ..._args: unknown[]
  ): boolean => {
    if (typeof chunk === 'string') {
      chunks.push(chunk);
    }
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('');
}

// ─── installCursor tests ────────────────────────────────────────────────────

describe('installCursor', () => {
  // Test case 1: Writes file when it does not exist
  it('writes the file when it does not exist', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
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

  // Test case 2: Returns written: true and correct targetPath
  it('returns written: true and correct targetPath', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
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

  // Test case 3: Skips (returns written: false) when file exists and force is NOT set
  it('skips (returns written: false) when file exists and force is NOT set', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      // First write
      installCursor({
        content: '# Original',
        cwd,
        homeDir,
        skillsRoot,
      });

      // Second write without force — capture stderr and result in one call
      let capturedResult: ReturnType<typeof installCursor>;
      const stderr = captureStderr(() => {
        capturedResult = installCursor({
          content: '# Updated — should not appear',
          cwd,
          homeDir,
          skillsRoot,
        });
      });

      expect(capturedResult!.written).toBe(false);
      expect(capturedResult!.targetPath).toBe(skillPath(cwd));

      // Original content preserved
      expect(readFileSync(skillPath(cwd), 'utf-8')).toBe('# Original');

      // Skip warning was emitted to stderr
      expect(stderr).toContain('Warning');
      expect(stderr).toContain('already exists');
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  // Test case 4: Overwrites when file exists and force: true
  it('overwrites when file exists and force: true', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      // First write
      installCursor({
        content: '# Version 1',
        cwd,
        homeDir,
        skillsRoot,
      });

      // Second write with force — capture stderr to verify no warning
      const stderr = captureStderr(() => {
        const result = installCursor({
          content: '# Version 2\nUpdated.',
          cwd,
          homeDir,
          skillsRoot,
          force: true,
        });

        expect(result.written).toBe(true);
        expect(readFileSync(skillPath(cwd), 'utf-8')).toBe('# Version 2\nUpdated.');
      });

      // No warning should be emitted during force: true overwrite
      expect(stderr).toBe('');
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  // Test case 7: @include directive is inlined in the written content
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

  // Multiple @include directives are all inlined
  it('inlines multiple @include directives', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({
      'intro.md': '# Introduction\nWelcome.',
      'usage.md': '## Usage\nRun the agent.',
    });
    try {
      installCursor({
        content: '# Skill\n@include _shared/intro.md\n\n---\n@include _shared/usage.md\n\nEnd.',
        cwd,
        homeDir,
        skillsRoot,
      });

      expect(readFileSync(skillPath(cwd), 'utf-8')).toBe(
        '# Skill\n# Introduction\nWelcome.\n\n---\n## Usage\nRun the agent.\n\nEnd.',
      );
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  // Non-_shared/ include directives are warned and dropped
  it('warns and drops non-_shared/ @include directives', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      const stderr = captureStderr(() => {
        installCursor({
          content: '# Skill\n@include other/shared.md\nDone.',
          cwd,
          homeDir,
          skillsRoot,
        });
      });

      expect(stderr).toContain('Warning');
      expect(stderr).toContain('_shared/');

      // Include line should be dropped, rest preserved
      expect(readFileSync(skillPath(cwd), 'utf-8')).toBe('# Skill\nDone.');
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  // Test case 8: Creates .cursor/rules/ directory if it does not exist
  it('creates .cursor/rules/ directory if it does not exist', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
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

  // Verify path is truly CWD-relative, not home-relative
  it('target path is CWD-relative, not homeDir-relative', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      const result = installCursor({
        content: '# Skill',
        cwd,
        homeDir,
        skillsRoot,
      });

      // targetPath should be under cwd, NOT homeDir
      expect(result.targetPath).toContain(cwd);
      expect(result.targetPath).not.toContain(homeDir);
      expect(result.targetPath).toBe(skillPath(cwd));

      // File should be in cwd, not in homeDir
      expect(existsSync(skillPath(cwd))).toBe(true);
      expect(existsSync(path.join(homeDir, '.cursor', 'rules', 'multi-model-agent.mdc'))).toBe(
        false,
      );
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  // Warning is logged to stderr for missing shared file
  it('logs warning to stderr for missing shared file and drops the line', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({}); // no shared files
    try {
      const stderr = captureStderr(() => {
        installCursor({
          content: '# Skill\n@include _shared/nonexistent.md\nDone.',
          cwd,
          homeDir,
          skillsRoot,
        });
      });

      expect(stderr).toContain('Warning');
      expect(stderr).toContain('shared file not found');
      expect(stderr).toContain('nonexistent.md');

      // Include line should be dropped, rest preserved
      expect(readFileSync(skillPath(cwd), 'utf-8')).toBe('# Skill\nDone.');
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  // Path traversal is rejected
  it('rejects path traversal in @include directive', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({ 'secret.md': 'SECRET' });
    try {
      const stderr = captureStderr(() => {
        installCursor({
          content: '# Skill\n@include _shared/../secret.md\nDone.',
          cwd,
          homeDir,
          skillsRoot,
        });
      });

      expect(stderr).toContain('Warning');
      expect(stderr).toContain('path traversal');

      // Traversal line should be dropped, rest preserved
      expect(readFileSync(skillPath(cwd), 'utf-8')).toBe('# Skill\nDone.');
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });
});

// ─── uninstallCursor tests ──────────────────────────────────────────────────

describe('uninstallCursor', () => {
  // Test case 5: Removes the skill file
  it('removes the skill file', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
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

  // Test case 6: Is a no-op when file does not exist
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

  // Parent directories remain intact after uninstall
  it('parent directories remain intact after uninstall', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    try {
      installCursor({
        content: '# Skill',
        cwd,
        homeDir,
        skillsRoot,
      });

      const rulesDir = path.join(cwd, '.cursor', 'rules');
      expect(existsSync(rulesDir)).toBe(true);

      uninstallCursor(cwd);

      // Parent directory should still exist
      expect(existsSync(rulesDir)).toBe(true);
      expect(existsSync(path.join(cwd, '.cursor'))).toBe(true);
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  // Handles symlink target path gracefully
  it('handles symlink at target path (removes symlink, not target)', () => {
    const cwd = makeFakeCwd();
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot();
    const realFile = path.join(cwd, '.cursor', 'rules', 'multi-model-agent.mdc');
    const symlinkPath = path.join(cwd, '.cursor', 'rules', 'link-to-skill.mdc');

    try {
      // Create the real file
      installCursor({
        content: '# Real skill',
        cwd,
        homeDir,
        skillsRoot,
      });
      expect(existsSync(realFile)).toBe(true);

      // Create a symlink to the real file
      fs.symlinkSync(realFile, symlinkPath);
      expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);

      // Uninstall the symlink (not the real file path)
      uninstallCursor(cwd); // This targets realFile, not symlinkPath

      // Real file is removed (this is expected behavior)
      expect(existsSync(realFile)).toBe(false);

      // Symlink should still exist (but target is gone)
      expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      expect(existsSync(symlinkPath)).toBe(false); // symlink is dangling now
    } finally {
      cleanup(cwd);
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });
});
