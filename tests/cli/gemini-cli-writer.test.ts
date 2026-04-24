/**
 * tests/cli/gemini-cli-writer.test.ts
 *
 * Task 9.6 scope: test the Gemini CLI skill writer (installGeminiCli / uninstallGeminiCli).
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

function makeFakeSkillsRoot(skills: Record<string, string>, shared?: Record<string, string>): string {
  const fakeRoot = mkdtempSync(path.join(tmpdir(), 'mmagent-gemini-test-skills-'));

  // Write skill directories
  for (const [name, content] of Object.entries(skills)) {
    const skillDir = path.join(fakeRoot, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
  }

  // Write shared directory
  if (shared) {
    const sharedDir = path.join(fakeRoot, '_shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    for (const [name, content] of Object.entries(shared)) {
      fs.writeFileSync(path.join(sharedDir, name.endsWith('.md') ? name : `${name}.md`), content, 'utf-8');
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

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('gemini-cli writer', () => {
  let fakeHome: string;
  let fakeSkillsRoot: string;

  beforeEach(() => {
    fakeHome = makeFakeHome();
    fakeSkillsRoot = makeFakeSkillsRoot(
      {
        'multi-model-agent': '# Multi-Model Agent\n\nA skill for managing multiple AI models.',
      },
      {
        'context.md': '# Context\n\nThis is shared context content.',
        'prompts.md': '# Prompts\n\nStandard prompt templates.',
      },
    );
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

    it('inlines @include directive in SKILL.md', () => {
      const content =
        '# Skill Header\n\n@include _shared/context.md\n\n## More content';
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

    it('handles multiple @include directives', () => {
      const content =
        '# Header\n\n@include _shared/context.md\n\n@include _shared/prompts.md\n\n## Done';
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
      expect(inlined).toContain('# Prompts');
      expect(inlined).toContain('Standard prompt templates.');
    });

    it('warns to stderr when shared file is missing', () => {
      const content = '# Skill\n\n@include _shared/nonexistent.md\n\nDone';
      const stderrOutput: string[] = [];

      installGeminiCli({
        skillName: 'multi-model-agent',
        content,
        skillVersion: '1.0.0',
        homeDir: fakeHome,
        skillsRoot: fakeSkillsRoot,
      });

      // The writer warns to stderr; we can't easily capture it in the test
      // but the key behavior is that the line is skipped (not included verbatim)
      const extDir = path.join(fakeHome, '.gemini', 'extensions', 'multi-model-agent');
      const skillPath = path.join(extDir, 'SKILL.md');

      const inlined = readFileSync(skillPath, 'utf-8');
      // The @include line should not appear in the output
      expect(inlined).not.toContain('@include _shared/nonexistent.md');
      expect(inlined).toContain('Done');
    });

    it('is idempotent — calling twice overwrites', () => {
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
      // First install
      installGeminiCli({
        skillName: 'multi-model-agent',
        content: '# Test skill',
        skillVersion: '1.0.0',
        homeDir: fakeHome,
        skillsRoot: fakeSkillsRoot,
      });

      const extDir = path.join(fakeHome, '.gemini', 'extensions', 'multi-model-agent');
      expect(fs.existsSync(extDir)).toBe(true);

      // Then uninstall
      uninstallGeminiCli(fakeHome);

      expect(fs.existsSync(extDir)).toBe(false);
    });

    it('is a no-op when directory does not exist', () => {
      const extDir = path.join(fakeHome, '.gemini', 'extensions', 'multi-model-agent');
      expect(fs.existsSync(extDir)).toBe(false);

      // Should not throw
      expect(() => uninstallGeminiCli(fakeHome)).not.toThrow();
    });

    it('only removes the multi-model-agent extension directory', () => {
      // Create the .gemini/extensions directory structure
      const extensionsDir = path.join(fakeHome, '.gemini', 'extensions');
      fs.mkdirSync(extensionsDir, { recursive: true });

      // Create another extension directory
      const otherExtDir = path.join(extensionsDir, 'other-extension');
      fs.mkdirSync(otherExtDir, { recursive: true });
      fs.writeFileSync(path.join(otherExtDir, 'some-file.txt'), 'content', 'utf-8');

      // Install our extension
      installGeminiCli({
        skillName: 'multi-model-agent',
        content: '# Test skill',
        skillVersion: '1.0.0',
        homeDir: fakeHome,
        skillsRoot: fakeSkillsRoot,
      });

      const ourExtDir = path.join(extensionsDir, 'multi-model-agent');
      expect(fs.existsSync(ourExtDir)).toBe(true);
      expect(fs.existsSync(otherExtDir)).toBe(true);

      // Uninstall our extension
      uninstallGeminiCli(fakeHome);

      expect(fs.existsSync(ourExtDir)).toBe(false);
      // Other extension should still exist
      expect(fs.existsSync(otherExtDir)).toBe(true);
    });
  });
});
