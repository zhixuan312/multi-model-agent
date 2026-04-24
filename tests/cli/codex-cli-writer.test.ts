/**
 * tests/cli/codex-cli-writer.test.ts
 *
 * Task 9.7 scope: integration tests for installCodexCli() and
 * uninstallCodexCli() against a fake filesystem (no touching of real
 * ~/.codex directories).
 *
 * All tests use mkdtempSync for fake homeDir and skillsRoot so they
 * are fully isolated from the host machine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';

import {
  installCodexCli,
  uninstallCodexCli,
} from '../../packages/server/src/install/codex-cli.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** Create a temp directory used as a fake homeDir. Caller removes it in afterEach. */
function makeFakeHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-codex-home-'));
}

/** Create a temp directory used as a fake skillsRoot. Caller removes it in afterEach. */
function makeFakeSkillsRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-codex-skills-'));
}

/** Clean up a temp directory safely. */
function rmFakeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Return the path to AGENTS.md inside a fake homeDir. */
function agentsMd(homeDir: string): string {
  return path.join(homeDir, '.codex', 'AGENTS.md');
}

/** Read AGENTS.md content, returning null if it does not exist. */
function readAgents(homeDir: string): string | null {
  const p = agentsMd(homeDir);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

/**
 * Create a _shared/ directory under skillsRoot with the given file→content map.
 * This lets tests exercise @include resolution.
 */
function populateShared(
  skillsRoot: string,
  files: Record<string, string>,
): void {
  const sharedDir = path.join(skillsRoot, '_shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(sharedDir, name), content, 'utf-8');
  }
}

// ─── Test suite ───────────────────────────────────────────────────────────────

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
    expect(content).toContain('<!-- multi-model-agent:BEGIN -->');
    expect(content).toContain('<!-- multi-model-agent:END -->');
    expect(content).toContain('# Skill content');
    expect(content).toContain('Some text here.');
  });

  // ── 2. Appends managed block to existing AGENTS.md with no markers ─────

  it('appends managed block to existing AGENTS.md with no markers', () => {
    const agentsPath = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      agentsPath,
      '# My Agents\n\nSome existing content.\n',
      'utf-8',
    );

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# New skill\nSkill content here.',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    expect(content).toContain('Some existing content.');
    expect(content).toContain('<!-- multi-model-agent:BEGIN -->');
    expect(content).toContain('<!-- multi-model-agent:END -->');
    expect(content).toContain('# New skill');
    // Existing content should come before the managed block
    expect(content.indexOf('Some existing content.')).toBeLessThan(
      content.indexOf('<!-- multi-model-agent:BEGIN -->'),
    );
  });

  // ── 3. Replaces managed block in existing AGENTS.md that already has markers ─

  it('replaces managed block in existing AGENTS.md that already has markers', () => {
    const agentsPath = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      agentsPath,
      `<!-- multi-model-agent:BEGIN -->
Old skill content.
<!-- multi-model-agent:END -->
Some user content after.
`,
      'utf-8',
    );

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# Updated skill\nNew content here.',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    expect(content).not.toContain('Old skill content.');
    expect(content).toContain('<!-- multi-model-agent:BEGIN -->');
    expect(content).toContain('# Updated skill');
    expect(content).toContain('New content here.');
    // User content after block should be preserved
    expect(content).toContain('Some user content after.');
  });

  // ── 4. User content BEFORE the managed block is preserved after install ─

  it('user content BEFORE the managed block is preserved after install', () => {
    const agentsPath = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      agentsPath,
      `# My custom AGENTS.md
User preamble content.

`,
      'utf-8',
    );

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# Skill content',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    expect(content).toContain('# My custom AGENTS.md');
    expect(content).toContain('User preamble content.');
    // Managed block should appear after user preamble
    const blockIdx = content.indexOf('<!-- multi-model-agent:BEGIN -->');
    expect(blockIdx).toBeGreaterThan(0);
  });

  // ── 5. User content AFTER the managed block is preserved after install ─

  it('user content AFTER the managed block is preserved after install', () => {
    const agentsPath = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      agentsPath,
      `<!-- multi-model-agent:BEGIN -->
Placeholder content.
<!-- multi-model-agent:END -->

# Post-install notes
This is user content that comes after the managed block.`,
      'utf-8',
    );

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# Updated content',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    expect(content).toContain('<!-- multi-model-agent:BEGIN -->');
    expect(content).toContain('# Updated content');
    expect(content).toContain('This is user content that comes after the managed block.');
  });

  // ── 6. User content BEFORE and AFTER both preserved simultaneously ──────

  it('user content BEFORE and AFTER both preserved simultaneously', () => {
    const agentsPath = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      agentsPath,
      `# Before block
Some pre-content.

<!-- multi-model-agent:BEGIN -->
Old content
<!-- multi-model-agent:END -->

Post-block content here.
## Another section`,
      'utf-8',
    );

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# New skill content',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    const content = readAgents(fakeHome)!;
    expect(content).toContain('# Before block');
    expect(content).toContain('Some pre-content.');
    expect(content).toContain('# New skill content');
    expect(content).toContain('Post-block content here.');
    expect(content).toContain('## Another section');
    // Old content must NOT be present
    expect(content).not.toContain('Old content');
  });

  // ── 10. @include directive is inlined in the skill content written to the managed block ─

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

  it('@include directive warns to stderr when shared file is missing', () => {
    // No shared files created — @include will fail to resolve
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: string) => {
      stderrLines.push(chunk.toString());
      return true;
    };

    installCodexCli({
      skillName: 'mma-delegate',
      content: '# Skill\n@include _shared/missing.md\nEnd.',
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = origWrite;

    // The warning should be written to stderr
    expect(stderrLines.some((l) => l.includes('missing shared file'))).toBe(true);
  });
});

// ─── Uninstall tests ─────────────────────────────────────────────────────────

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

  // ── 7. uninstallCodexCli removes managed block, preserves surrounding user content ─

  it('removes managed block, preserves surrounding user content', () => {
    const agentsPath = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      agentsPath,
      `# Header
Pre-block content.

<!-- multi-model-agent:BEGIN -->
Some skill content.
<!-- multi-model-agent:END -->

Post-block content.`,
      'utf-8',
    );

    uninstallCodexCli(fakeHome);

    const content = readAgents(fakeHome);
    expect(content).not.toBeNull();
    expect(content).toContain('# Header');
    expect(content).toContain('Pre-block content.');
    expect(content).toContain('Post-block content.');
    expect(content).not.toContain('<!-- multi-model-agent:BEGIN -->');
    expect(content).not.toContain('<!-- multi-model-agent:END -->');
    expect(content).not.toContain('Some skill content.');
  });

  it('removes managed block when it is the only content (file deleted)', () => {
    const agentsPath = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      agentsPath,
      `<!-- multi-model-agent:BEGIN -->
Skill content.
<!-- multi-model-agent:END -->
`,
      'utf-8',
    );

    uninstallCodexCli(fakeHome);

    expect(readAgents(fakeHome)).toBeNull();
  });

  it('removes managed block when file has only whitespace after removal', () => {
    const agentsPath = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      agentsPath,
      `   \t

<!-- multi-model-agent:BEGIN -->
Skill content.
<!-- multi-model-agent:END -->

  \t
`,
      'utf-8',
    );

    uninstallCodexCli(fakeHome);

    // After removing the block, the remaining content is whitespace-only,
    // so the file should be deleted.
    expect(readAgents(fakeHome)).toBeNull();
  });

  // ── 8. uninstallCodexCli is a no-op when file does not exist ──────────

  it('is a no-op when file does not exist', () => {
    // Do not create .codex directory
    expect(() => uninstallCodexCli(fakeHome)).not.toThrow();
    expect(readAgents(fakeHome)).toBeNull();
  });

  // ── 9. uninstallCodexCli is a no-op when file has no managed block markers ─

  it('is a no-op when file has no managed block markers', () => {
    const agentsPath = agentsMd(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(agentsPath, '# Custom agents file\nNo markers here.', 'utf-8');

    uninstallCodexCli(fakeHome);

    const content = readAgents(fakeHome);
    expect(content).toContain('# Custom agents file');
    expect(content).toContain('No markers here.');
  });
});