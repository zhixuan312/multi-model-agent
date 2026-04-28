/**
 * tests/cli/install-skill.test.ts
 *
 * Task 9.4 scope: manifest read/write, dry-run mode, CLI argv parsing,
 * auto-detection, resolveTargets, manifest integration with doInstall/doUninstall.
 *
 * Client writers (tasks 9.5–9.8) and removers (task 9.9) are tested separately.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  manifestPath,
  manifestDir,
  listEntries,
  getEntry,
  appendEntry,
  removeEntry,
  isInstalled,
} from '../../packages/server/src/install/manifest.js';

import {
  parseArgs,
  resolveTargets,
  doInstall,
  doUninstall,
  detectClients,
  Client,
  SUPPORTED_SKILLS,
  ALL_CLIENTS,
} from '../../packages/server/src/cli/install-skill.js';

// ─── Temp home setup ────────────────────────────────────────────────────────

function makeFakeHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'mmagent-test-home-'));
}

function removeFakeHome(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─── Mock skills root ────────────────────────────────────────────────────────

/**
 * Creates a temp skills directory populated with the given skill→content map.
 * Returns the fake root path; caller is responsible for cleanup.
 */
function makeFakeSkillsRoot(skills: Record<string, string>): string {
  const fakeRoot = mkdtempSync(path.join(tmpdir(), 'mmagent-test-skills-'));
  for (const [name, content] of Object.entries(skills)) {
    const skillDir = path.join(fakeRoot, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
  }
  return fakeRoot;
}

// ─── Manifest tests ─────────────────────────────────────────────────────────

describe('manifest', () => {
  it('manifestDir uses homeDir when provided', () => {
    expect(manifestDir('/my/home')).toBe(path.join('/my/home', '.multi-model'));
  });

  it('manifestPath uses homeDir when provided', () => {
    expect(manifestPath('/my/home')).toBe(
      path.join('/my/home', '.multi-model', 'install-manifest.json'),
    );
  });

  it('listEntries returns empty array when manifest does not exist', () => {
    const home = makeFakeHome();
    try {
      expect(listEntries(home)).toEqual([]);
    } finally {
      removeFakeHome(home);
    }
  });

  it('listEntries returns entries from existing manifest', () => {
    const home = makeFakeHome();
    try {
      const manifestFile = path.join(home, '.multi-model', 'install-manifest.json');
      fs.mkdirSync(path.join(home, '.multi-model'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        manifestFile,
        JSON.stringify({
          version: 1,
          entries: [
            { name: 'mma-delegate', version: '1.0.0', installedAt: 1000, targets: ['claude-code'] },
          ],
        }),
        'utf-8',
      );
      expect(listEntries(home)).toHaveLength(1);
      expect(listEntries(home)[0].name).toBe('mma-delegate');
    } finally {
      removeFakeHome(home);
    }
  });

  it('appendEntry creates manifest with one entry', () => {
    const home = makeFakeHome();
    try {
      appendEntry('mma-delegate', '1.0.0', ['claude-code'], home);
      const manifestFile = path.join(home, '.multi-model', 'install-manifest.json');
      expect(existsSync(manifestFile)).toBe(true);
      const raw = JSON.parse(readFileSync(manifestFile, 'utf-8')) as { entries: unknown[] };
      expect(raw.entries).toHaveLength(1);
      expect((raw.entries[0] as { name: string }).name).toBe('mma-delegate');
    } finally {
      removeFakeHome(home);
    }
  });

  it('appendEntry merges targets for same skill', () => {
    const home = makeFakeHome();
    try {
      appendEntry('mma-delegate', '1.0.0', ['claude-code'], home);
      appendEntry('mma-delegate', '1.0.0', ['gemini'], home);
      const entries = listEntries(home);
      expect(entries).toHaveLength(1);
      expect(entries[0].targets).toContain('claude-code');
      expect(entries[0].targets).toContain('gemini');
    } finally {
      removeFakeHome(home);
    }
  });

  it('appendEntry does not duplicate targets', () => {
    const home = makeFakeHome();
    try {
      appendEntry('mma-delegate', '1.0.0', ['claude-code'], home);
      appendEntry('mma-delegate', '1.0.0', ['claude-code'], home);
      expect(listEntries(home)[0].targets).toHaveLength(1);
    } finally {
      removeFakeHome(home);
    }
  });

  it('removeEntry removes specific targets', () => {
    const home = makeFakeHome();
    try {
      appendEntry('mma-delegate', '1.0.0', ['claude-code', 'gemini'], home);
      const removed = removeEntry('mma-delegate', ['claude-code'], home);
      expect(removed).toContain('claude-code');
      const entries = listEntries(home);
      expect(entries).toHaveLength(1);
      expect(entries[0].targets).not.toContain('claude-code');
      expect(entries[0].targets).toContain('gemini');
    } finally {
      removeFakeHome(home);
    }
  });

  it('removeEntry removes whole entry when targets array is empty', () => {
    const home = makeFakeHome();
    try {
      appendEntry('mma-delegate', '1.0.0', ['claude-code'], home);
      const removed = removeEntry('mma-delegate', [], home);
      expect(removed).toContain('claude-code');
      expect(listEntries(home)).toHaveLength(0);
    } finally {
      removeFakeHome(home);
    }
  });

  it('removeEntry returns empty array for unknown skill', () => {
    const home = makeFakeHome();
    try {
      expect(removeEntry('unknown-skill', [], home)).toEqual([]);
    } finally {
      removeFakeHome(home);
    }
  });

  it('isInstalled returns true when skill has targets', () => {
    const home = makeFakeHome();
    try {
      appendEntry('mma-delegate', '1.0.0', ['claude-code'], home);
      expect(isInstalled('mma-delegate', home)).toBe(true);
    } finally {
      removeFakeHome(home);
    }
  });

  it('isInstalled returns false when skill not in manifest', () => {
    const home = makeFakeHome();
    try {
      expect(isInstalled('unknown-skill', home)).toBe(false);
    } finally {
      removeFakeHome(home);
    }
  });
});

// ─── CLI parseArgs tests ────────────────────────────────────────────────────

describe('install-skill CLI: parseArgs', () => {
  it('parses skill name positional argument', () => {
    const result = parseArgs(['mma-delegate']);
    expect(result.skill).toBe('mma-delegate');
    expect(result.uninstall).toBe(false);
    expect(result.dryRun).toBe(false);
  });

  it('parses --uninstall', () => {
    const result = parseArgs(['--uninstall', 'mma-delegate']);
    expect(result.uninstall).toBe(true);
    expect(result.skill).toBe('mma-delegate');
  });

  it('parses --uninstall short form -u', () => {
    const result = parseArgs(['-u', 'mma-delegate']);
    expect(result.uninstall).toBe(true);
  });

  it('parses --dry-run', () => {
    const result = parseArgs(['--dry-run', 'mma-delegate']);
    expect(result.dryRun).toBe(true);
  });

  it('parses --json', () => {
    const result = parseArgs(['--json', 'mma-delegate']);
    expect(result.json).toBe(true);
  });

  it('parses --json short form -j', () => {
    const result = parseArgs(['-j', 'mma-delegate']);
    expect(result.json).toBe(true);
  });

  it('parses --target with single value', () => {
    const result = parseArgs(['--target', 'claude-code', 'mma-delegate']);
    expect(result.targets).toEqual(['claude-code']);
  });

  it('parses --target with multiple values', () => {
    const result = parseArgs(['--target', 'claude-code', '--target', 'gemini', 'mma-delegate']);
    expect(result.targets).toEqual(['claude-code', 'gemini']);
  });

  it('parses --target short form -t', () => {
    const result = parseArgs(['-t', 'cursor', 'mma-delegate']);
    expect(result.targets).toEqual(['cursor']);
  });

  it('parses --all-targets', () => {
    const result = parseArgs(['--all-targets', 'mma-delegate']);
    expect(result.allTargets).toBe(true);
  });

  it('parses --config', () => {
    const result = parseArgs(['--config', '/path/to/config.json', 'mma-delegate']);
    expect(result.configPath).toBe('/path/to/config.json');
  });

  it('parses --config short form -c', () => {
    const result = parseArgs(['-c', '/path/to/config.json', 'mma-delegate']);
    expect(result.configPath).toBe('/path/to/config.json');
  });

  it('defaults targets to null (auto-detect)', () => {
    const result = parseArgs(['mma-delegate']);
    expect(result.targets).toBeNull();
  });

  it('defaults configPath to null', () => {
    const result = parseArgs(['mma-delegate']);
    expect(result.configPath).toBeNull();
  });
});

// ─── detectClients tests ─────────────────────────────────────────────────────

describe('install-skill CLI: detectClients', () => {
  it('returns empty array when no client dirs exist', () => {
    const home = makeFakeHome();
    try {
      expect(detectClients(home)).toEqual([]);
    } finally {
      removeFakeHome(home);
    }
  });

  it('detects claude-code when .claude/skills exists', () => {
    const home = makeFakeHome();
    try {
      fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
      expect(detectClients(home)).toContain('claude-code');
    } finally {
      removeFakeHome(home);
    }
  });

  it('detects gemini when .gemini/extensions exists', () => {
    const home = makeFakeHome();
    try {
      fs.mkdirSync(path.join(home, '.gemini', 'extensions'), { recursive: true });
      expect(detectClients(home)).toContain('gemini');
    } finally {
      removeFakeHome(home);
    }
  });

  it('detects codex when .codex exists', () => {
    const home = makeFakeHome();
    try {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      expect(detectClients(home)).toContain('codex');
    } finally {
      removeFakeHome(home);
    }
  });

  it('detects cursor when .cursor/rules exists', () => {
    const home = makeFakeHome();
    try {
      fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });
      expect(detectClients(home)).toContain('cursor');
    } finally {
      removeFakeHome(home);
    }
  });

  it('detects multiple clients simultaneously', () => {
    const home = makeFakeHome();
    try {
      fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
      fs.mkdirSync(path.join(home, '.gemini', 'extensions'), { recursive: true });
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });
      const detected = detectClients(home);
      expect(detected).toContain('claude-code');
      expect(detected).toContain('gemini');
      expect(detected).toContain('codex');
      expect(detected).toContain('cursor');
    } finally {
      removeFakeHome(home);
    }
  });
});

// ─── resolveTargets tests ───────────────────────────────────────────────────

describe('install-skill CLI: resolveTargets', () => {
  it('allTargets returns all four clients', () => {
    const result = resolveTargets(null, true, '/fake/home');
    expect(result).toEqual(['claude-code', 'gemini', 'codex', 'cursor']);
    expect(result).toHaveLength(4);
  });

  it('explicit targets are validated and returned', () => {
    const result = resolveTargets(['claude-code', 'gemini'], false, '/fake/home');
    expect(result).toEqual(['claude-code', 'gemini']);
  });

  it('unknown target throws with clear message', () => {
    expect(() => resolveTargets(['invalid-target' as Client], false, '/fake/home'))
      .toThrow(/Unknown target: invalid-target/);
  });

  it('auto-detects clients present in homeDir', () => {
    const home = makeFakeHome();
    try {
      fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
      fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });
      const result = resolveTargets(null, false, home);
      expect(result).toContain('claude-code');
      expect(result).toContain('cursor');
    } finally {
      removeFakeHome(home);
    }
  });

  it('returns empty array when no clients detected', () => {
    const home = makeFakeHome();
    try {
      expect(resolveTargets(null, false, home)).toEqual([]);
    } finally {
      removeFakeHome(home);
    }
  });
});

// ─── doInstall / doUninstall tests ─────────────────────────────────────────

describe('install-skill CLI: doInstall / doUninstall', () => {
  let fakeHome: string;
  let fakeSkillsRoot: string;

  beforeEach(() => {
    fakeHome = makeFakeHome();
    fakeSkillsRoot = makeFakeSkillsRoot({
      'mma-delegate': '# mma-delegate skill content',
      'mma-audit': '# mma-audit skill content',
      'multi-model-agent': '# Overview skill',
    });
  });

  afterEach(() => {
    removeFakeHome(fakeHome);
    try {
      rmSync(fakeSkillsRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('doInstall dryRun=true returns skipped targets without writing files', () => {
    const result = doInstall('mma-delegate', ['claude-code', 'gemini'], {
      dryRun: true,
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
    });
    expect(result.action).toBe('installed');
    expect(result.skipped).toContain('claude-code');
    expect(result.skipped).toContain('gemini');
    expect(result.targets).toHaveLength(0);
    expect(result.dryRun).toBe(true);
  });

  it('doInstall dryRun=false writes SKILL.md for claude-code target', () => {
    // Tasks 9.5–9.8 implement the writers; verify actual file write.
    const result = doInstall('mma-delegate', ['claude-code'], {
      dryRun: false,
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
      version: '3.0.0',
    });
    expect(result.action).toBe('installed');
    expect(result.targets).toContain('claude-code');
    expect(result.skipped).toHaveLength(0);
    // Claude Code writes to ~/.claude/skills/<skillName>/SKILL.md
    const skillFile = path.join(fakeHome, '.claude', 'skills', 'mma-delegate', 'SKILL.md');
    expect(fs.existsSync(skillFile)).toBe(true);
    expect(fs.readFileSync(skillFile, 'utf-8')).toContain('# mma-delegate skill content');
  });

  it('doInstall throws when skill is not found', () => {
    expect(() =>
      doInstall('nonexistent-skill', ['claude-code'], {
        dryRun: true,
        homeDir: fakeHome,
        skillsRoot: fakeSkillsRoot,
      }),
    ).toThrow(/not found/);
  });

  it('doUninstall dryRun=true returns skipped targets without removing files', () => {
    const result = doUninstall('mma-delegate', ['claude-code'], {
      dryRun: true,
      homeDir: fakeHome,
    });
    expect(result.action).toBe('uninstalled');
    expect(result.skipped).toContain('claude-code');
    expect(result.targets).toHaveLength(0);
  });

  it('doUninstall dryRun=false removes skill files for claude-code target', () => {
    // First install so there is something to uninstall
    doInstall('mma-delegate', ['claude-code'], {
      dryRun: false,
      homeDir: fakeHome,
      skillsRoot: fakeSkillsRoot,
      version: '3.0.0',
    });
    const skillFile = path.join(fakeHome, '.claude', 'skills', 'mma-delegate', 'SKILL.md');
    expect(fs.existsSync(skillFile)).toBe(true);

    // Now uninstall
    const result = doUninstall('mma-delegate', ['claude-code'], {
      dryRun: false,
      homeDir: fakeHome,
    });
    expect(result.action).toBe('uninstalled');
    expect(result.targets).toContain('claude-code');
    expect(fs.existsSync(skillFile)).toBe(false);
  });

  it('SUPPORTED_SKILLS includes all expected skills', () => {
    expect(SUPPORTED_SKILLS).toContain('mma-delegate');
    expect(SUPPORTED_SKILLS).toContain('mma-audit');
    expect(SUPPORTED_SKILLS).toContain('multi-model-agent');
    expect(SUPPORTED_SKILLS).toContain('mma-investigate');
    expect(SUPPORTED_SKILLS).toHaveLength(11);
  });

  it('ALL_CLIENTS includes all four clients', () => {
    expect(ALL_CLIENTS).toEqual(['claude-code', 'gemini', 'codex', 'cursor']);
  });
});
