import { describe, it, expect } from 'vitest';
import { findMissingSkills, type ManifestEntry } from '../../packages/server/src/skill-install/manifest.js';

describe('findMissingSkills', () => {
  it('returns empty list when all SUPPORTED_SKILLS are in the manifest', () => {
    const manifest: ManifestEntry[] = [
      { name: 'mma-delegate', skillVersion: '1', installedAt: 0, targets: ['claude-code'] },
      { name: 'mma-investigate', skillVersion: '1', installedAt: 0, targets: ['claude-code'] },
    ];
    const supported = ['mma-delegate', 'mma-investigate'];
    expect(findMissingSkills(manifest, supported)).toEqual([]);
  });

  it('returns skills present in SUPPORTED but not in manifest, with target union from existing entries', () => {
    const manifest: ManifestEntry[] = [
      { name: 'mma-delegate', skillVersion: '1', installedAt: 0, targets: ['claude-code'] },
      { name: 'mma-audit',    skillVersion: '1', installedAt: 0, targets: ['codex'] },
    ];
    const supported = ['mma-delegate', 'mma-audit', 'mma-investigate'];
    expect(findMissingSkills(manifest, supported)).toEqual([
      { name: 'mma-investigate', targets: ['claude-code', 'codex'] },
    ]);
  });

  it('returns empty when manifest is empty (no client opted in)', () => {
    expect(findMissingSkills([], ['mma-delegate', 'mma-investigate'])).toEqual([]);
  });

  it('returns empty when manifest has entries but no targets at all', () => {
    const manifest: ManifestEntry[] = [{ name: 'mma-delegate', skillVersion: '1', installedAt: 0, targets: [] }];
    expect(findMissingSkills(manifest, ['mma-delegate', 'mma-investigate'])).toEqual([]);
  });
});
