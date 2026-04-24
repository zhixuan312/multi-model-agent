/**
 * tests/cli/gemini-cli-writer.test.ts
 *
 * Task 9.6 scope: test the Gemini CLI skill writer (installGeminiCli / uninstallGeminiCli).
 * Tests use mkdtempSync for fake homeDir and skillsRoot. Never touch real ~/.gemini.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { installGeminiCli, uninstallGeminiCli } from '../../packages/server/src/install/gemini-cli.js';

// ─── Temp directory helpers ─────────────────────────────────────────────────

function makeFakeHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-gemini-test-home-'));
}

function makeFakeSkillsRoot(shared?: Record<string, string>): string {
  const fakeRoot = mkdtempSync(path.join(tmpdir(), 'mmagent-gemini-test-skills-'));

  if (shared) {
    const sharedDir = path.join(fakeRoot, '_shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    for (const [name, content] of Object.entries(shared)) {
      fs.writeFileSync(
        path.join(sharedDir, name.endsWith('.md') ? name : `${name}.md`),
        content,
        'utf-8',
      );
    }
  }

  return fakeRoot;
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─── Tests (exactly 6 required test cases) ─────────────────────────────────

describe('gemini-cli writer', () => {
  let fakeHome: string;
  let fakeSkillsRoot: string;

  beforeEach(() => {
    fakeHome = makeFakeHome();
    fakeSkillsRoot = makeFakeSkillsRoot({
      'context.md': '# Context\n\nThis is shared context content.',
    });
  });

  afterEach(() => {
    removeDir(fakeHome);
    removeDir(fakeSkillsRoot);
  });

  describe('installGeminiCli', () => {
    it('writes gemini-extension.json with correct shape', () => {
      installGeminiCli({
        skillName: 'multi-model-agent',
        content: '# Test skill',
        skillVersion: '1.0.0',
        homeDir: fakeHome,
        skillsRoot: fakeSkillsRoot,
      });

      const extDir = path.join(fakeHome, '.gemini', 'extensions', 'multi-model-agent');
      const manifestPath = path.join(extDir, 'gemini-extension.json');

      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest).toEqual({
        name: 'multi-model-agent',
        version: '1.0.0',
        description: 'multi-model-agent skills for Gemini CLI',
        schemaVersion: '1.0',
        contextFiles: ['SKILL.md'],
      });
    });

    it('writes SKILL.md with content', () => {
      const content = '# Test Skill\n\nThis is the skill content.';
      installGeminiCli({
        skillName: 'multi-model-agent',
        content,
        skillVersion: '1.0.0',
        homeDir: fakeHome,
        skillsRoot: fakeSkillsRoot,
      });

      const extDir = path.join(fakeHome, '.gemini', 'extensions', 'multi-model-agent');
      const skillPath = path.join(extDir, 'SKILL.md');

      expect(fs.existsSync(skillPath)).toBe(true);
      expect(readFileSync(skillPath, 'utf-8').trim()).toBe('# Test Skill\n\nThis is the skill content.');
    });

    it('@include directive is inlined in SKILL.md', () => {
      const content = '# Skill Header\n\n@include _shared/context.md\n\n## More content';
      installGeminiCli({
        skillName: 'multi-model-agent',
        content,
        skillVersion: '1.0.0',
        homeDir: fakeHome,
        skillsRoot: fakeSkillsRoot,
      });

      const extDir = path.join(fakeHome, '.gemini', 'extensions', 'multi-model-agent');
      const skillPath = path.join(extDir, 'SKILL.md');

      const inlined = readFileSync(skillPath, 'utf-8');
      expect(inlined).toContain('# Context');
      expect(inlined).toContain('This is shared context content.');
      expect(inlined).not.toContain('@include');
    });

    it('calling installGeminiCli twice overwrites (idempotent)', () => {
      installGeminiCli({
        skillName: 'multi-model-agent',
        content: '# Version 1',
        skillVersion: '1.0.0',
        homeDir: fakeHome,
        skillsRoot: fakeSkillsRoot,
      });

      installGeminiCli({
        skillName: 'multi-model-agent',
        content: '# Version 2',
        skillVersion: '2.0.0',
        homeDir: fakeHome,
        skillsRoot: fakeSkillsRoot,
      });

      const extDir = path.join(fakeHome, '.gemini', 'extensions', 'multi-model-agent');
      const skillPath = path.join(extDir, 'SKILL.md');
      const manifestPath = path.join(extDir, 'gemini-extension.json');

      expect(readFileSync(skillPath, 'utf-8').trim()).toBe('# Version 2');

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.version).toBe('2.0.0');
    });
  });

  describe('uninstallGeminiCli', () => {
    it('removes the extension directory', () => {
      installGeminiCli({
        skillName: 'multi-model-agent',
        content: '# Test skill',
        skillVersion: '1.0.0',
        homeDir: fakeHome,
        skillsRoot: fakeSkillsRoot,
      });

      const extDir = path.join(fakeHome, '.gemini', 'extensions', 'multi-model-agent');
      expect(fs.existsSync(extDir)).toBe(true);

      uninstallGeminiCli(fakeHome);

      expect(fs.existsSync(extDir)).toBe(false);
    });

    it('is a no-op when directory does not exist', () => {
      const extDir = path.join(fakeHome, '.gemini', 'extensions', 'multi-model-agent');
      expect(fs.existsSync(extDir)).toBe(false);

      expect(() => uninstallGeminiCli(fakeHome)).not.toThrow();
    });
  });
});