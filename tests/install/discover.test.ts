import { describe, it, expect } from 'vitest';
import { discoverPerClientInstallDirs } from '../../packages/server/src/install/discover.js';
import type { Client } from '../../packages/server/src/install/manifest.js';

describe('discoverPerClientInstallDirs', () => {
  it('returns paths for claude-code and codex only', () => {
    const dirs = discoverPerClientInstallDirs('/home/testuser');
    const keys = Object.keys(dirs) as Client[];
    expect(keys).toContain('claude-code');
    expect(keys).toContain('codex');
    expect(keys).not.toContain('gemini');
    expect(keys).not.toContain('cursor');
  });

  it('returns claude-code path under ~/.claude/skills', () => {
    const dirs = discoverPerClientInstallDirs('/home/testuser');
    expect(dirs['claude-code']).toBe('/home/testuser/.claude/skills');
  });

  it('returns codex path under ~/.codex/skills', () => {
    const dirs = discoverPerClientInstallDirs('/home/testuser');
    expect(dirs['codex']).toBe('/home/testuser/.codex/skills');
  });

  it('uses os.homedir() when homeDir is not provided', () => {
    // Should not throw and should return valid paths
    const dirs = discoverPerClientInstallDirs();
    expect(typeof dirs['claude-code']).toBe('string');
    expect(typeof dirs['codex']).toBe('string');
    expect(dirs['claude-code']!.endsWith('/.claude/skills')).toBe(true);
    expect(dirs['codex']!.endsWith('/.codex/skills')).toBe(true);
  });

  it('returns only two entries (not gemini or cursor)', () => {
    const dirs = discoverPerClientInstallDirs('/tmp/test');
    const keys = Object.keys(dirs);
    expect(keys).toHaveLength(2);
  });

  it('returns type-compatible Partial<Record<Client, string>>', () => {
    const dirs = discoverPerClientInstallDirs();
    // Verify the return type is usable as Partial<Record<Client, string>>
    const typed: Partial<Record<Client, string>> = dirs;
    expect(typed).toBe(dirs);
  });
});
