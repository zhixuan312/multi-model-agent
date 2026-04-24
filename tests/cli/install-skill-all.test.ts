/**
 * tests/cli/install-skill-all.test.ts — `install-skill --all-skills` flag.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main, parseArgs, SUPPORTED_SKILLS } from '../../packages/server/src/cli/install-skill.js';
import { appendEntry, listEntries } from '../../packages/server/src/install/manifest.js';

function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    outFn: (s: string) => { out.push(s); return true; },
    errFn: (s: string) => { err.push(s); return true; },
  };
}

function mkSandbox(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'install-all-'));
  // make the home dir look like it has claude-code installed
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe('install-skill --all-skills flag', () => {
  const sandboxes: Array<() => void> = [];
  afterEach(() => {
    for (const c of sandboxes.splice(0)) c();
  });

  it('parseArgs: --all-skills alone is accepted', () => {
    const parsed = parseArgs(['--all-skills']);
    expect(parsed.allSkills).toBe(true);
    expect(parsed.skill).toBe(null);
  });

  it('parseArgs: a positional skill without --all-skills sets skill, allSkills=false', () => {
    const parsed = parseArgs(['mma-delegate']);
    expect(parsed.allSkills).toBe(false);
    expect(parsed.skill).toBe('mma-delegate');
  });

  it('--all-skills installs every shipped skill to claude-code', async () => {
    const { home, cleanup } = mkSandbox();
    sandboxes.push(cleanup);
    const c = cap();
    const code = await main({
      argv: ['--all-skills', '--target=claude-code', '--json'],
      homeDir: home,
      stdout: c.outFn,
      stderr: c.errFn,
    });
    expect(code).toBe(0);

    // Each supported skill appears in the manifest with at least one target
    const entries = listEntries(home);
    for (const skill of SUPPORTED_SKILLS) {
      const entry = entries.find((e) => e.name === skill);
      expect(entry, `skill ${skill} should be in manifest`).toBeDefined();
      expect(entry!.targets).toContain('claude-code');
    }
  });

  it('--all-skills combined with a positional skill errors out', async () => {
    const { home, cleanup } = mkSandbox();
    sandboxes.push(cleanup);
    const c = cap();
    const code = await main({
      argv: ['--all-skills', '--target=claude-code', 'mma-delegate'],
      homeDir: home,
      stdout: c.outFn,
      stderr: c.errFn,
    });
    expect(code).not.toBe(0);
    expect(c.err.join('')).toMatch(/all-skills/);
  });

  it('--all-skills --uninstall removes every manifest-tracked skill', async () => {
    const { home, cleanup } = mkSandbox();
    sandboxes.push(cleanup);

    // Install first
    const c1 = cap();
    await main({
      argv: ['--all-skills', '--target=claude-code'],
      homeDir: home,
      stdout: c1.outFn,
      stderr: c1.errFn,
    });
    expect(listEntries(home).length).toBe(SUPPORTED_SKILLS.length);

    // Uninstall all
    const c2 = cap();
    const code = await main({
      argv: ['--all-skills', '--uninstall', '--target=claude-code'],
      homeDir: home,
      stdout: c2.outFn,
      stderr: c2.errFn,
    });
    expect(code).toBe(0);
    expect(listEntries(home).length).toBe(0);
  });

  it('--all-skills without --target/--all-targets uses detection (empty if no clients)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'install-all-empty-'));
    sandboxes.push(() => rmSync(home, { recursive: true, force: true }));
    const c = cap();
    const code = await main({
      argv: ['--all-skills'],
      homeDir: home,
      stdout: c.outFn,
      stderr: c.errFn,
    });
    expect(code).not.toBe(0);
    expect(c.out.join('') + c.err.join('')).toMatch(/No clients detected|--target|--all-targets/);
  });
});
