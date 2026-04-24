/**
 * Task 9.6: tests for the Gemini CLI skill writer.
 *
 * All tests use mkdtempSync for fake homeDir and fake skillsRoot.
 * Never touch real ~/.gemini.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  installGeminiCli,
  uninstallGeminiCli,
  inlineIncludes,
} from '../../packages/server/src/install/gemini-cli.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFakeHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-gemini-cli-home-'));
}

function makeFakeSkillsRoot(sharedFiles: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mmagent-gemini-cli-skills-'));
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

function extDir(homeDir: string): string {
  return path.join(homeDir, '.gemini', 'extensions', 'multi-model-agent');
}

function manifestPath(homeDir: string): string {
  return path.join(extDir(homeDir), 'gemini-extension.json');
}

function skillPath$1(homeDir: string): string {
  return path.join(extDir(homeDir), 'SKILL.md');
}

// ─── inlineIncludes tests ───────────────────────────────────────────────────

describe('inlineIncludes', () => {
  it('returns content unchanged when no directives present', () => {
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      const content = '# Hello\n\nThis is a skill.';
      expect(inlineIncludes(content, skillsRoot)).toBe('# Hello\n\nThis is a skill.');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('inlines a single @include directive', () => {
    const skillsRoot = makeFakeSkillsRoot({ 'endpoints.md': '## Endpoints\n- GET /api' });
    try {
      const content = '# My Skill\n@include _shared/endpoints.md\nDone.';
      const result = inlineIncludes(content, skillsRoot);
      expect(result).toBe('# My Skill\n## Endpoints\n- GET /api\nDone.');
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

  it('inlines nested path @include directives', () => {
    const skillsRoot = makeFakeSkillsRoot({ 'utils/logging.md': '## Logging\n- info()\n- error()' });
    try {
      const content = '### Usage\n@include _shared/utils/logging.md';
      const result = inlineIncludes(content, skillsRoot);
      expect(result).toBe('### Usage\n## Logging\n- info()\n- error()');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('logs warning to stderr for missing shared file and drops the line', () => {
    const skillsRoot = makeFakeSkillsRoot({}); // no shared files
    try {
      const content = '# Skill\n@include _shared/nonexistent.md\nRest.';
      const result = inlineIncludes(content, skillsRoot);
      // Include line is removed; rest is preserved
      expect(result).toBe('# Skill\nRest.');
    } finally {
      cleanup(skillsRoot);
    }
  });

  it('preserves lines that do not start with @include', () => {
    const skillsRoot = makeFakeSkillsRoot({ 'common.md': 'Shared.' });
    try {
      const content = '# Skill\n@include _shared/common.md\nNot a directive: @include something.';
      const result = inlineIncludes(content, skillsRoot);
      expect(result).toBe('# Skill\nShared.\nNot a directive: @include something.');
    } finally {
      cleanup(skillsRoot);
    }
  });
});

// ─── installGeminiCli tests ─────────────────────────────────────────────────

describe('installGeminiCli', () => {
  it('writes gemini-extension.json with correct shape', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      installGeminiCli({
        skillName: 'mma-delegate',
        content: '# delegate skill',
        skillVersion: '1.2.3',
        homeDir,
        skillsRoot,
      });

      const m = manifestPath(homeDir);
      expect(existsSync(m)).toBe(true);

      const parsed = JSON.parse(readFileSync(m, 'utf-8'));
      expect(parsed).toEqual({
        name: 'multi-model-agent',
        version: '1.2.3',
        description: 'multi-model-agent skills for Gemini CLI',
        schemaVersion: '1.0',
        contextFiles: ['SKILL.md'],
      });
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('writes SKILL.md with content', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      installGeminiCli({
        skillName: 'mma-audit',
        content: '# mma-audit skill\n\nSome content here.',
        skillVersion: '0.1.0',
        homeDir,
        skillsRoot,
      });

      const dest = skillPath$1(homeDir);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, 'utf-8')).toBe('# mma-audit skill\n\nSome content here.');
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('@include directive is inlined in SKILL.md', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({ 'endpoints.md': '## Endpoints\n- GET /' });
    try {
      installGeminiCli({
        skillName: 'mma-review',
        content: '# mma-review\n@include _shared/endpoints.md',
        skillVersion: '0.5.0',
        homeDir,
        skillsRoot,
      });

      const dest = skillPath$1(homeDir);
      expect(readFileSync(dest, 'utf-8')).toBe('# mma-review\n## Endpoints\n- GET /');
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('is idempotent — calling twice overwrites previous content', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      installGeminiCli({
        skillName: 'mma-delegate',
        content: '# Version 1',
        skillVersion: '1.0.0',
        homeDir,
        skillsRoot,
      });

      installGeminiCli({
        skillName: 'mma-delegate',
        content: '# Version 2\nUpdated content.',
        skillVersion: '2.0.0',
        homeDir,
        skillsRoot,
      });

      const dest = skillPath$1(homeDir);
      expect(readFileSync(dest, 'utf-8')).toBe('# Version 2\nUpdated content.');

      // Manifest version also updated
      const parsed = JSON.parse(readFileSync(manifestPath(homeDir), 'utf-8'));
      expect(parsed.version).toBe('2.0.0');
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('creates parent directories if they do not exist', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      expect(existsSync(path.join(homeDir, '.gemini'))).toBe(false);

      installGeminiCli({
        skillName: 'new-skill',
        content: '# New skill',
        skillVersion: '0.0.1',
        homeDir,
        skillsRoot,
      });

      expect(existsSync(skillPath$1(homeDir))).toBe(true);
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });

  it('logs warning and continues when shared file is missing', () => {
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
        installGeminiCli({
          skillName: 'mma-verify',
          content: '# Verify\n@include _shared/missing.md\nDone.',
          skillVersion: '0.1.0',
          homeDir,
          skillsRoot,
        });

        const dest = skillPath$1(homeDir);
        // Include directive removed; Done. preserved
        expect(readFileSync(dest, 'utf-8')).toBe('# Verify\nDone.');

        // Warning was logged
        const warning = stderrLines.join('');
        expect(warning).toContain('Warning');
        expect(warning).toContain('missing.md');
      } finally {
        process.stderr.write = orig;
      }
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });
});

// ─── uninstallGeminiCli tests ───────────────────────────────────────────────

describe('uninstallGeminiCli', () => {
  it('removes the extension directory', () => {
    const homeDir = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot({});
    try {
      installGeminiCli({
        skillName: 'mma-delegate',
        content: '# delegate',
        skillVersion: '1.0.0',
        homeDir,
        skillsRoot,
      });

      expect(existsSync(extDir(homeDir))).toBe(true);

      uninstallGeminiCli(homeDir);

      expect(existsSync(extDir(homeDir))).toBe(false);
      // Parent .gemini dir may survive
      expect(existsSync(path.join(homeDir, '.gemini'))).toBe(true);
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
      expect(() => uninstallGeminiCli(homeDir)).not.toThrow();

      // Should not crash even when .gemini doesn't exist
      expect(existsSync(path.join(homeDir, '.gemini'))).toBe(false);
      expect(() => uninstallGeminiCli(homeDir)).not.toThrow();
    } finally {
      cleanup(homeDir);
      cleanup(skillsRoot);
    }
  });
});