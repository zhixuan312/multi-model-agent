/**
 * tests/cli/cursor-writer.test.ts
 *
 * Tests for the Cursor skill writer (packages/server/src/install/cursor.ts).
 *
 * All tests use mkdtempSync for both fake cwd and homeDir. Never touch real .cursor/.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';

import { installCursor, uninstallCursor } from '../../packages/server/src/install/cursor.js';

// ─── Temp helper ─────────────────────────────────────────────────────────────

function makeFakeHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'mmagent-test-cursor-home-'));
}

function makeFakeCwd(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'mmagent-test-cursor-cwd-'));
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─── Mock skills root helper ─────────────────────────────────────────────────

/**
 * Creates a temp skills directory with optional _shared/ subdirectory.
 * Returns the fake root path; caller is responsible for cleanup.
 */
function makeFakeSkillsRoot(sharedFiles?: Record<string, string>): string {
  const fakeRoot = mkdtempSync(path.join(os.tmpdir(), 'mmagent-test-skills-'));
  if (sharedFiles) {
    const sharedDir = path.join(fakeRoot, '_shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    for (const [name, content] of Object.entries(sharedFiles)) {
      fs.writeFileSync(path.join(sharedDir, name), content, 'utf-8');
    }
  }
  return fakeRoot;
}

// ─── capture stderr ─────────────────────────────────────────────────────────

function captureStderr(): {
  lines: string[];
  fn: (s: string) => boolean;
} {
  const lines: string[] = [];
  return {
    lines,
    fn: (s: string) => { lines.push(s); return true; },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('installCursor', () => {
  let fakeCwd: string;
  let fakeHome: string;
  let fakeSkillsRoot: string;

  beforeEach(() => {
    fakeCwd = makeFakeCwd();
    fakeHome = makeFakeHome();
    fakeSkillsRoot = makeFakeSkillsRoot();
  });

  afterEach(() => {
    removeDir(fakeCwd);
    removeDir(fakeHome);
    removeDir(fakeSkillsRoot);
  });

  it('1. writes file when it does not exist', () => {
    const content = '# Multi-Model Agent skill for Cursor';
    const result = installCursor({
      content,
      cwd: fakeCwd,
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const expectedPath = path.join(fakeCwd, '.cursor', 'rules', 'multi-model-agent.mdc');
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, 'utf-8')).toBe(content);
    expect(result.written).toBe(true);
  });

  it('2. returns written: true and correct targetPath', () => {
    const result = installCursor({
      content: 'some skill content',
      cwd: fakeCwd,
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const expectedPath = path.join(fakeCwd, '.cursor', 'rules', 'multi-model-agent.mdc');
    expect(result.written).toBe(true);
    expect(result.targetPath).toBe(expectedPath);
  });

  it('3. skips (written: false) when file exists and force is NOT set', () => {
    // Pre-create the file.
    const rulesDir = path.join(fakeCwd, '.cursor', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'multi-model-agent.mdc'),
      'existing content',
      'utf-8',
    );

    const result = installCursor({
      content: 'new content',
      cwd: fakeCwd,
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
      force: false,
    });

    expect(result.written).toBe(false);
    expect(readFileSync(path.join(rulesDir, 'multi-model-agent.mdc'), 'utf-8')).toBe(
      'existing content',
    );
  });

  it('3. emits warning to stderr when file exists and force is NOT set', () => {
    const rulesDir = path.join(fakeCwd, '.cursor', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'multi-model-agent.mdc'),
      'existing content',
      'utf-8',
    );

    const { lines } = captureStderr();
    // Patch process.stderr.write so the test can assert on captured output.
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string) => {
      lines.push(s);
      return orig(s);
    } as typeof process.stderr.write;
    try {
      installCursor({
        content: 'new content',
        cwd: fakeCwd,
        homeDir: fakeHome,
        skillsRoot: fakeSkillsRoot,
        force: false,
      });
    } finally {
      process.stderr.write = orig;
    }

    expect(lines.some((l) => l.includes('skipping') || l.includes('already installed'))).toBe(true);
  });

  it('4. overwrites when file exists and force: true', () => {
    // Pre-create the file.
    const rulesDir = path.join(fakeCwd, '.cursor', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'multi-model-agent.mdc'),
      'original content',
      'utf-8',
    );

    const result = installCursor({
      content: 'overwritten content',
      cwd: fakeCwd,
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
      force: true,
    });

    expect(result.written).toBe(true);
    expect(readFileSync(path.join(rulesDir, 'multi-model-agent.mdc'), 'utf-8')).toBe(
      'overwritten content',
    );
  });

  it('8. creates .cursor/rules/ directory if it does not exist', () => {
    // fakeCwd has no .cursor directory at all.
    expect(existsSync(path.join(fakeCwd, '.cursor'))).toBe(false);

    installCursor({
      content: 'skill content',
      cwd: fakeCwd,
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    expect(existsSync(path.join(fakeCwd, '.cursor', 'rules', 'multi-model-agent.mdc'))).toBe(true);
  });
});

describe('uninstallCursor', () => {
  let fakeCwd: string;
  let fakeHome: string;

  beforeEach(() => {
    fakeCwd = makeFakeCwd();
    fakeHome = makeFakeHome();
  });

  afterEach(() => {
    removeDir(fakeCwd);
    removeDir(fakeHome);
  });

  function installSkillFile(cwd: string, content: string): void {
    const rulesDir = path.join(cwd, '.cursor', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'multi-model-agent.mdc'), content, 'utf-8');
  }

  it('5. removes the file', () => {
    installSkillFile(fakeCwd, 'some skill content');
    const targetPath = path.join(fakeCwd, '.cursor', 'rules', 'multi-model-agent.mdc');
    expect(existsSync(targetPath)).toBe(true);

    uninstallCursor(fakeCwd);

    expect(existsSync(targetPath)).toBe(false);
  });

  it('6. is a no-op when file does not exist', () => {
    const targetPath = path.join(fakeCwd, '.cursor', 'rules', 'multi-model-agent.mdc');
    expect(existsSync(targetPath)).toBe(false);

    // Should not throw.
    uninstallCursor(fakeCwd);

    expect(existsSync(targetPath)).toBe(false);
  });
});

describe('@include inlining', () => {
  let fakeCwd: string;
  let fakeHome: string;
  let fakeSkillsRoot: string;

  beforeEach(() => {
    fakeCwd = makeFakeCwd();
    fakeHome = makeFakeHome();
  });

  afterEach(() => {
    removeDir(fakeCwd);
    removeDir(fakeHome);
    if (fakeSkillsRoot) removeDir(fakeSkillsRoot);
  });

  it('7. @include directive is inlined in the written content', () => {
    fakeSkillsRoot = makeFakeSkillsRoot({
      'intro.md': 'This is the **intro** section.',
      'usage.md': '## Usage\nUse it like this.',
    });

    const content = [
      '# Multi-Model Agent for Cursor',
      '',
      '@include _shared/intro.md',
      '',
      '@include _shared/usage.md',
    ].join('\n');

    const result = installCursor({
      content,
      cwd: fakeCwd,
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    expect(result.written).toBe(true);

    const written = readFileSync(result.targetPath, 'utf-8');
    expect(written).toContain('This is the **intro** section.');
    expect(written).toContain('## Usage');
    expect(written).toContain('Use it like this.');
  });

  it('7. warns and skips line when @include shared file is missing', () => {
    // No shared files.
    fakeSkillsRoot = makeFakeSkillsRoot({});

    const content = [
      '# Skill',
      '@include _shared/missing.md',
      '## End',
    ].join('\n');

    const { lines } = captureStderr();
    const orig = process.stderr.write.bind(process.stderr);
    const patched = (s: string) => {
      lines.push(s);
      return orig(s);
    };
    process.stderr.write = patched as typeof process.stderr.write;
    try {
      installCursor({ content, cwd: fakeCwd, homeDir: fakeHome, skillsRoot: fakeSkillsRoot });
    } finally {
      process.stderr.write = orig;
    }

    expect(lines.some((l) => l.includes('missing.md') || l.includes('not found'))).toBe(true);

    const written = readFileSync(
      path.join(fakeCwd, '.cursor', 'rules', 'multi-model-agent.mdc'),
      'utf-8',
    );
    expect(written).toContain('# Skill');
    expect(written).toContain('## End');
    expect(written).not.toContain('@include _shared/missing.md');
  });

  it('7. multiple @include directives are all inlined', () => {
    fakeSkillsRoot = makeFakeSkillsRoot({
      'a.md': 'Shared A',
      'b.md': 'Shared B',
      'c.md': 'Shared C',
    });

    const content = [
      '# Header',
      '@include _shared/a.md',
      'Middle',
      '@include _shared/b.md',
      '@include _shared/c.md',
      'Footer',
    ].join('\n');

    installCursor({ content, cwd: fakeCwd, homeDir: fakeHome, skillsRoot: fakeSkillsRoot });

    const written = readFileSync(
      path.join(fakeCwd, '.cursor', 'rules', 'multi-model-agent.mdc'),
      'utf-8',
    );
    expect(written).toContain('Shared A');
    expect(written).toContain('Shared B');
    expect(written).toContain('Shared C');
    expect(written).toContain('Header');
    expect(written).toContain('Middle');
    expect(written).toContain('Footer');
  });
});
