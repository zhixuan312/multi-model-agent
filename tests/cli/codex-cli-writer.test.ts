/**
 * tests/cli/codex-cli-writer.test.ts
 *
 * Task 9.7: integration tests for installCodexCli() and uninstallCodexCli().
 *
 * All tests use mkdtempSync for fake homeDir and fake skillsRoot so they
 * never touch the real ~/.codex directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';

import { installCodexCli, uninstallCodexCli } from '../../packages/server/src/install/codex-cli.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeFakeHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-codex-home-'));
}

function makeFakeSkillsRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-codex-skills-'));
}

function rmFakeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function agentsMd(homeDir: string): string {
  return path.join(homeDir, '.codex', 'AGENTS.md');
}

function readAgents(homeDir: string): string | null {
  const p = agentsMd(homeDir);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
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

// ─── installCodexCli tests ─────────────────────────────────────────────────

describe('installCodexCli', () => {
  let fakeHome: string;
  let fakeSkillsRoot: string;

  beforeEach(() => {
    fakeHome = makeFakeHome();
    fakeSkillsRoot = makeFakeSkillsRoot();
  });

  afterEach(() => {
    rmFakeDir(fakeHome);
    rmFakeDir(fakeSkillsRoot);
  });

  // ── 1. Creates AGENTS.md with managed block when file does not exist ─────

  it('creates AGENTS.md with managed block when file does not exist', () => {
    installCodexCli({
      skillName: 'mma-delegate',
      content: '# Skill content\nSome text here.',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome);
    expect(content).not.toBeNull();
    // Exact content check
    expect(content).toBe(
      '<!-- multi-model-agent:BEGIN -->\n' +
      '# Skill content\nSome text here.\n' +
      '<!-- multi-model-agent:END -->',
    );
  });

  // ── 2. Appends managed block to existing AGENTS.md with no markers ─────

  it('appends managed block to existing AGENTS.md with no markers', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(ap, '# My Agents\n\nSome existing content.\n', 'utf-8');

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# New skill\nSkill content here.',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    // Exact content: original + one blank line separator + block
    expect(content).toBe(
      '# My Agents\n\nSome existing content.\n\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      '# New skill\nSkill content here.\n' +
      '<!-- multi-model-agent:END -->',
    );
  });

  it('appends managed block with blank-line separator when existing content ends with \\n', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    // File ends with exactly one newline
    fs.writeFileSync(ap, 'Existing line.\n', 'utf-8');

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# Skill',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    // Exactly one blank line (one \n separator + one \n from block start)
    // between existing content and BEGIN marker
    expect(content).toBe(
      'Existing line.\n\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      '# Skill\n' +
      '<!-- multi-model-agent:END -->',
    );
  });

  it('appends managed block without extra separator when existing content ends without \\n', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    // File does not end with newline
    fs.writeFileSync(ap, 'Existing line.', 'utf-8');

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# Skill',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    expect(content).toBe(
      'Existing line.\n\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      '# Skill\n' +
      '<!-- multi-model-agent:END -->',
    );
  });

  // ── 3. Replaces managed block in existing AGENTS.md that already has markers ─

  it('replaces managed block when markers already exist', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      ap,
      '<!-- multi-model-agent:BEGIN -->\n' +
      'Old skill content.\n' +
      '<!-- multi-model-agent:END -->\n' +
      'Some user content after.\n',
      'utf-8',
    );

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# Updated skill\nNew content here.',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    expect(content).toBe(
      '<!-- multi-model-agent:BEGIN -->\n' +
      '# Updated skill\nNew content here.\n' +
      '<!-- multi-model-agent:END -->\n' +
      'Some user content after.\n',
    );
  });

  // ── 4. User content BEFORE the managed block is preserved verbatim ─────

  it('user content BEFORE the managed block is preserved verbatim', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      ap,
      '# My custom AGENTS.md\n' +
      'User preamble content.\n\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      'Old block\n' +
      '<!-- multi-model-agent:END -->\n',
      'utf-8',
    );

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# New block content',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    expect(content).toBe(
      '# My custom AGENTS.md\n' +
      'User preamble content.\n\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      '# New block content\n' +
      '<!-- multi-model-agent:END -->\n',
    );
  });

  // ── 5. User content AFTER the managed block is preserved verbatim ─────

  it('user content AFTER the managed block is preserved verbatim', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      ap,
      '<!-- multi-model-agent:BEGIN -->\n' +
      'Old block\n' +
      '<!-- multi-model-agent:END -->\n\n' +
      '# Post-install notes\n' +
      'This is user content that comes after the managed block.\n',
      'utf-8',
    );

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# Updated content',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    expect(content).toBe(
      '<!-- multi-model-agent:BEGIN -->\n' +
      '# Updated content\n' +
      '<!-- multi-model-agent:END -->\n\n' +
      '# Post-install notes\n' +
      'This is user content that comes after the managed block.\n',
    );
  });

  // ── 6. User content BEFORE and AFTER both preserved simultaneously ──────

  it('user content BEFORE and AFTER both preserved simultaneously', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      ap,
      '# Before block\n' +
      'Some pre-content.\n\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      'Old content\n' +
      '<!-- multi-model-agent:END -->\n\n' +
      'Post-block content here.\n' +
      '## Another section\n',
      'utf-8',
    );

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# New skill content',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    expect(content).toBe(
      '# Before block\n' +
      'Some pre-content.\n\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      '# New skill content\n' +
      '<!-- multi-model-agent:END -->\n\n' +
      'Post-block content here.\n' +
      '## Another section\n',
    );
  });

  // ── 10. @include directive is inlined in the skill content ─────────────

  it('@include directive is inlined in the skill content written to the managed block', () => {
    populateShared(fakeSkillsRoot, {
      'shared-snippet.md': '## Shared snippet\nThis is shared content.',
    });

    installCodexCli({
      skillName: 'mma-delegate',
      content:
        '# Skill with include\n\n@include _shared/shared-snippet.md\n\nEnd of skill.',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    expect(content).toContain('## Shared snippet');
    expect(content).toContain('This is shared content.');
    // The @include directive line itself must NOT appear in output
    expect(content).not.toContain('@include _shared/shared-snippet.md');
  });

  it('warns to stderr when shared file is missing during install', () => {
    // No shared files created
    const stderrLines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: string) => {
      stderrLines.push(chunk.toString());
      return true;
    };
    try {
      installCodexCli({
        skillName: 'mma-missing',
        content: '# Skill\n@include _shared/missing.md\nEnd.',
        homeDir: fakeHome,
        skillsRoot: fakeSkillsRoot,
      });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = orig;
    }
    expect(stderrLines.some((l) => l.includes('missing shared file'))).toBe(true);
    expect(stderrLines.some((l) => l.includes('mma-missing'))).toBe(true);
  });

  // ── Malformed-marker test: END before BEGIN must NOT corrupt user content ─

  it('does NOT corrupt user content when markers are in corrupt order (END before BEGIN)', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    // END appears before BEGIN — corrupt order that could destroy content
    // if splitAroundBlock() blindly removes from END onwards.
    fs.writeFileSync(
      ap,
      '# My custom notes\n' +
      'Irreplaceable user content.\n\n' +
      '<!-- multi-model-agent:END -->\n' +
      'Block content.\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      'More user notes.\n',
      'utf-8',
    );

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# New block',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    // Original user content must be preserved verbatim.
    // Block should be appended (since the corrupt markers prevent a valid
    // block replacement).
    expect(content).toContain('# My custom notes');
    expect(content).toContain('Irreplaceable user content.');
    expect(content).toContain('More user notes.');
    expect(content).toContain('<!-- multi-model-agent:BEGIN -->');
    expect(content).toContain('<!-- multi-model-agent:END -->');
  });
});

// ─── uninstallCodexCli tests ─────────────────────────────────────────────────

describe('uninstallCodexCli', () => {
  let fakeHome: string;
  let fakeSkillsRoot: string;

  beforeEach(() => {
    fakeHome = makeFakeHome();
    fakeSkillsRoot = makeFakeSkillsRoot();
  });

  afterEach(() => {
    rmFakeDir(fakeHome);
    rmFakeDir(fakeSkillsRoot);
  });

  // ── 7. removes managed block, preserves surrounding user content ───────

  it('removes managed block, preserves surrounding user content', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      ap,
      '# Header\n' +
      'Pre-block content.\n\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      'Some skill content.\n' +
      '<!-- multi-model-agent:END -->\n' +
      'Post-block content.\n',
      'utf-8',
    );

    uninstallCodexCli(fakeHome);

    const content = readAgents(fakeHome);
    expect(content).not.toBeNull();
    expect(content).toBe(
      '# Header\n' +
      'Pre-block content.\n\n' +
      'Post-block content.\n',
    );
  });

  it('removes managed block when it is the only content (file deleted)', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      ap,
      '<!-- multi-model-agent:BEGIN -->\n' +
      'Skill content.\n' +
      '<!-- multi-model-agent:END -->\n',
      'utf-8',
    );

    uninstallCodexCli(fakeHome);

    expect(readAgents(fakeHome)).toBeNull();
  });

  it('deletes the file when only whitespace remains after removal', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      ap,
      '   \t\n\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      'Skill content.\n' +
      '<!-- multi-model-agent:END -->\n' +
      '  \t\n',
      'utf-8',
    );

    uninstallCodexCli(fakeHome);

    expect(readAgents(fakeHome)).toBeNull();
  });

  it('preserves exact verbatim spacing in file with prefix and suffix content', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    // Two blank lines between prefix content and the block.
    // The suffix (post-block) starts with a blank line (\n) followed by user content.
    fs.writeFileSync(
      ap,
      '# Custom\n\n' +
      'Pre.\n\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      'Block.\n' +
      '<!-- multi-model-agent:END -->\n\n' +
      'Post.\n\n',
      'utf-8',
    );

    uninstallCodexCli(fakeHome);

    const content = readAgents(fakeHome)!;
    // The suffix's leading blank line is structural (belongs to the block's
    // END line), so it is not added on top of the user's blank lines.
    // The two user blank lines between Pre and block are preserved.
    expect(content).toBe('# Custom\n\nPre.\n\nPost.\n\n');
  });

  it('removes managed block with no gap when suffix has no leading blank line', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      ap,
      'Pre.\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      'Block.\n' +
      '<!-- multi-model-agent:END -->' +
      'Post.\n',
      'utf-8',
    );

    uninstallCodexCli(fakeHome);

    const content = readAgents(fakeHome)!;
    // No blank lines between Pre and Post — block is removed cleanly.
    expect(content).toBe('Pre.\nPost.\n');
  });

  // ── 8. is a no-op when file does not exist ────────────────────────────

  it('is a no-op when file does not exist', () => {
    // Do not create .codex directory
    expect(() => uninstallCodexCli(fakeHome)).not.toThrow();
    expect(readAgents(fakeHome)).toBeNull();
  });

  // ── 9. is a no-op when file has no managed block markers ─────────────

  it('is a no-op when file has no managed block markers', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(ap, '# Custom agents file\nNo markers here.\n', 'utf-8');

    uninstallCodexCli(fakeHome);

    const content = readAgents(fakeHome);
    expect(content).toBe('# Custom agents file\nNo markers here.\n');
  });

  it('is a no-op when file has only one orphan marker (BEGIN without END)', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      ap,
      '<!-- multi-model-agent:BEGIN -->\n' +
      'Orphan BEGIN with no END marker.\n',
      'utf-8',
    );

    uninstallCodexCli(fakeHome);

    const content = readAgents(fakeHome);
    expect(content).toBe(
      '<!-- multi-model-agent:BEGIN -->\n' +
      'Orphan BEGIN with no END marker.\n',
    );
  });

  it('is a no-op when file has only one orphan marker (END without BEGIN)', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      ap,
      'Orphan END without BEGIN marker.\n' +
      '<!-- multi-model-agent:END -->\n',
      'utf-8',
    );

    uninstallCodexCli(fakeHome);

    const content = readAgents(fakeHome);
    expect(content).toBe(
      'Orphan END without BEGIN marker.\n' +
      '<!-- multi-model-agent:END -->\n',
    );
  });

  it('is a no-op when markers are in corrupt order (END before BEGIN)', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    // Both markers present but END comes before BEGIN.
    // Safe implementation must NOT remove content from END onwards,
    // as that could destroy user content before BEGIN.
    fs.writeFileSync(
      ap,
      'Valuable content.\n' +
      '<!-- multi-model-agent:END -->\n' +
      'Middle.\n' +
      '<!-- multi-model-agent:BEGIN -->\n',
      'utf-8',
    );

    uninstallCodexCli(fakeHome);

    // File should be completely unchanged — no valid block to remove.
    const content = readAgents(fakeHome);
    expect(content).toBe(
      'Valuable content.\n' +
      '<!-- multi-model-agent:END -->\n' +
      'Middle.\n' +
      '<!-- multi-model-agent:BEGIN -->\n',
    );
  });

  it('re-installing a skill updates the block while preserving surrounding content', () => {
    const ap = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      ap,
      '# My AGENTS.md\n\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      'Version 1 block.\n' +
      '<!-- multi-model-agent:END -->\n\n' +
      'User notes.\n',
      'utf-8',
    );

    // First install
    installCodexCli({
      skillName: 'mma-delegate',
      content: '# Version 1 block.',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    // Second install (update)
    installCodexCli({
      skillName: 'mma-delegate',
      content: '# Version 2 block\nUpdated content.',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    expect(content).toBe(
      '# My AGENTS.md\n\n' +
      '<!-- multi-model-agent:BEGIN -->\n' +
      '# Version 2 block\nUpdated content.\n' +
      '<!-- multi-model-agent:END -->\n\n' +
      'User notes.\n',
    );
    expect(content).not.toContain('Version 1');
  });
});
