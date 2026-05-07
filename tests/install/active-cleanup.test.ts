import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeCleanup, findOrphanedSkills } from '@zhixuan92/multi-model-agent-core/tool-surface/skill-installer';

describe('activeCleanup', () => {
  it('removes orphaned mma-clarifications on re-install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'install-'));
    mkdirSync(join(dir, 'mma-delegate'), { recursive: true });
    mkdirSync(join(dir, 'mma-clarifications'), { recursive: true });
    writeFileSync(join(dir, 'mma-clarifications', 'SKILL.md'), 'orphan');
    const removed = activeCleanup(dir, ['mma-delegate']);
    expect(removed).toContain('mma-clarifications');
    expect(existsSync(join(dir, 'mma-clarifications'))).toBe(false);
    expect(existsSync(join(dir, 'mma-delegate'))).toBe(true);
  });

  it('keeps all canonical skills intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'install-'));
    mkdirSync(join(dir, 'mma-delegate'), { recursive: true });
    mkdirSync(join(dir, 'mma-audit'), { recursive: true });
    writeFileSync(join(dir, 'mma-delegate', 'SKILL.md'), 'content');
    writeFileSync(join(dir, 'mma-audit', 'SKILL.md'), 'content');
    const removed = activeCleanup(dir, ['mma-delegate', 'mma-audit', 'mma-review']);
    expect(removed).toEqual([]);
    expect(existsSync(join(dir, 'mma-delegate'))).toBe(true);
    expect(existsSync(join(dir, 'mma-audit'))).toBe(true);
  });

  it('removes multiple orphans at once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'install-'));
    mkdirSync(join(dir, 'mma-delegate'), { recursive: true });
    mkdirSync(join(dir, 'mma-clarifications'), { recursive: true });
    mkdirSync(join(dir, 'mma-old-skill'), { recursive: true });
    writeFileSync(join(dir, 'mma-clarifications', 'SKILL.md'), 'orphan1');
    writeFileSync(join(dir, 'mma-old-skill', 'SKILL.md'), 'orphan2');
    const removed = activeCleanup(dir, ['mma-delegate']);
    expect(removed).toContain('mma-clarifications');
    expect(removed).toContain('mma-old-skill');
    expect(removed.length).toBe(2);
    expect(existsSync(join(dir, 'mma-clarifications'))).toBe(false);
    expect(existsSync(join(dir, 'mma-old-skill'))).toBe(false);
    expect(existsSync(join(dir, 'mma-delegate'))).toBe(true);
  });

  it('returns empty array when install dir does not exist', () => {
    const removed = activeCleanup('/nonexistent/path/12345', ['mma-delegate']);
    expect(removed).toEqual([]);
  });

  it('ignores non-mma entries in the install dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'install-'));
    mkdirSync(join(dir, 'other-tool'), { recursive: true });
    mkdirSync(join(dir, 'mma-delegate'), { recursive: true });
    writeFileSync(join(dir, 'other-tool', 'README.md'), 'not an mma skill');
    const removed = activeCleanup(dir, ['mma-delegate']);
    expect(removed).toEqual([]);
    expect(existsSync(join(dir, 'other-tool'))).toBe(true);
    expect(existsSync(join(dir, 'mma-delegate'))).toBe(true);
  });
});

describe('findOrphanedSkills', () => {
  it('returns manifest entries not in supported skills', () => {
    const manifest = [
      { name: 'mma-delegate', skillVersion: '1.0', installedAt: 1000, targets: ['claude-code' as const] },
      { name: 'mma-clarifications', skillVersion: '1.0', installedAt: 1000, targets: ['claude-code' as const] },
      { name: 'mma-audit', skillVersion: '1.0', installedAt: 1000, targets: ['codex' as const] },
    ];
    const supported = ['mma-delegate', 'mma-audit', 'mma-review'];
    const orphans = findOrphanedSkills(manifest, supported);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.name).toBe('mma-clarifications');
    expect(orphans[0]!.targets).toEqual(['claude-code']);
  });

  it('returns empty when all manifest entries are supported', () => {
    const manifest = [
      { name: 'mma-delegate', skillVersion: '1.0', installedAt: 1000, targets: ['claude-code' as const] },
    ];
    const supported = ['mma-delegate', 'mma-audit'];
    const orphans = findOrphanedSkills(manifest, supported);
    expect(orphans).toEqual([]);
  });

  it('returns empty when manifest has no entries', () => {
    expect(findOrphanedSkills([], ['mma-delegate'])).toEqual([]);
  });
});
