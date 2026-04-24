/**
 * tests/cli/install-skill-all.test.ts — default-all-skills behavior.
 *
 * `install-skill` with no positional skill name installs every shipped skill.
 * A positional skill name scopes to that one skill.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main, parseArgs, SUPPORTED_SKILLS } from '../../packages/server/src/cli/install-skill.js';
import { listEntries } from '../../packages/server/src/install/manifest.js';

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
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe('install-skill default-all behavior', () => {
  const sandboxes: Array<() => void> = [];
  afterEach(() => {
    for (const c of sandboxes.splice(0)) c();
  });

  it('parseArgs: no args gives skill=null (defaulting to all)', () => {
    const parsed = parseArgs([]);
    expect(parsed.skill).toBe(null);
  });

  it('parseArgs: positional skill name sets skill', () => {
    const parsed = parseArgs(['mma-delegate']);
    expect(parsed.skill).toBe('mma-delegate');
  });

  it('no positional skill installs every shipped skill to claude-code', async () => {
    const { home, cleanup } = mkSandbox();
    sandboxes.push(cleanup);
    const c = cap();
    const code = await main({
      argv: ['--target=claude-code', '--json'],
      homeDir: home,
      stdout: c.outFn,
      stderr: c.errFn,
    });
    expect(code).toBe(0);

    const entries = listEntries(home);
    for (const skill of SUPPORTED_SKILLS) {
      const entry = entries.find((e) => e.name === skill);
      expect(entry, `skill ${skill} should be in manifest`).toBeDefined();
      expect(entry!.targets).toContain('claude-code');
    }
  });

  it('positional skill scopes to that one skill only', async () => {
    const { home, cleanup } = mkSandbox();
    sandboxes.push(cleanup);
    const c = cap();
    const code = await main({
      argv: ['mma-delegate', '--target=claude-code'],
      homeDir: home,
      stdout: c.outFn,
      stderr: c.errFn,
    });
    expect(code).toBe(0);
    const entries = listEntries(home);
    expect(entries.map((e) => e.name)).toEqual(['mma-delegate']);
  });

  it('--uninstall with no positional skill removes every manifest-tracked skill', async () => {
    const { home, cleanup } = mkSandbox();
    sandboxes.push(cleanup);

    // Install all first
    const c1 = cap();
    await main({
      argv: ['--target=claude-code'],
      homeDir: home,
      stdout: c1.outFn,
      stderr: c1.errFn,
    });
    expect(listEntries(home).length).toBe(SUPPORTED_SKILLS.length);

    // Uninstall all
    const c2 = cap();
    const code = await main({
      argv: ['--uninstall', '--target=claude-code'],
      homeDir: home,
      stdout: c2.outFn,
      stderr: c2.errFn,
    });
    expect(code).toBe(0);
    expect(listEntries(home).length).toBe(0);
  });

  it('unknown positional skill errors out', async () => {
    const { home, cleanup } = mkSandbox();
    sandboxes.push(cleanup);
    const c = cap();
    const code = await main({
      argv: ['not-a-real-skill', '--target=claude-code'],
      homeDir: home,
      stdout: c.outFn,
      stderr: c.errFn,
    });
    expect(code).not.toBe(0);
    expect(c.err.join('')).toMatch(/Unknown skill/);
  });
});
