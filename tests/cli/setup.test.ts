/**
 * `mma setup` — the one interactive command.
 *
 * The contract these pin is the two-line first run: `npm i -g` then `mma setup`,
 * and nothing typed on any upgrade after. That only holds if setup WRITES a
 * durable config — both the tiers and the client roster — so the postinstall's
 * `sync-skills` has something to reconcile against.
 */
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSetup, SetupExitCode } from '../../packages/server/src/cli/setup.js';

/** Answers are consumed in order; a question with no scripted answer returns ''
 *  (i.e. "accept the default"), which is what pressing Enter does. */
function scripted(answers: string[], confirms: boolean[]) {
  const a = [...answers];
  const c = [...confirms];
  const asked: string[] = [];
  return {
    asked,
    ask: async (q: string, fallback?: string) => { asked.push(q); return a.shift() ?? fallback ?? ''; },
    confirm: async (q: string, fallback: boolean) => { asked.push(q); const n = c.shift(); return n === undefined ? fallback : n; },
  };
}

function freshHome(): { home: string; configPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'mma-setup-'));
  mkdirSync(join(home, '.claude'), { recursive: true });   // a detectable client
  return { home, configPath: join(home, '.mma', 'config.json') };
}

const readConfig = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('contract: mma setup writes a usable config on a machine that had none', () => {
  it('creates the config file, both tiers, and the client roster in one pass', async () => {
    const { home, configPath } = freshHome();
    expect(existsSync(configPath), 'nothing exists before setup').toBe(false);

    const s = scripted(
      ['claude', 'claude-opus-5', 'claude', 'claude-sonnet-5', 'codex', 'gpt-5.6'],
      [true /* main oauth */, true /* complex oauth */, true /* standard oauth */, true /* provision claude-code */],
    );
    const code = await runSetup({
      homeDir: home, configPath, skipProbe: true, detected: new Set(['claude-code' as never]),
      stdout: () => true, stderr: () => true, ask: s.ask, confirm: s.confirm,
    } as never);

    expect(code).toBe(SetupExitCode.SUCCESS);
    const cfg = readConfig(configPath);
    expect(cfg.agents.main).toMatchObject({ type: 'claude', model: 'claude-opus-5' });
    expect(cfg.agents.complex).toMatchObject({ type: 'claude', model: 'claude-sonnet-5' });
    expect(cfg.agents.standard).toMatchObject({ type: 'codex', model: 'gpt-5.6' });
    expect(cfg.clients['claude-code'], 'the roster is what makes later upgrades silent').toBe('on');
  });

  it('never writes a credential into the config — only the env var NAME', async () => {
    // A config file is a backup/dotfile/git footgun. Even when the user is
    // configuring an API key, what lands on disk is a reference.
    const { home, configPath } = freshHome();
    // Three tiers, none skippable. Per tier the prompts are:
    // provider → oauth? → env var → base URL → model.
    const s = scripted(
      [
        'claude', 'MY_SECRET_KEY', '', 'claude-opus-5',
        'claude', 'MY_SECRET_KEY', '', 'claude-sonnet-5',
        'claude', 'MY_SECRET_KEY', '', 'claude-haiku-4-5',
      ],
      [
        false /* main: not oauth → api key */,
        false /* complex: not oauth */,
        false /* standard: not oauth */,
        false /* no clients */,
      ],
    );
    await runSetup({
      homeDir: home, configPath, skipProbe: true, detected: new Set(),
      stdout: () => true, stderr: () => true, ask: s.ask, confirm: s.confirm,
    });

    const raw = readFileSync(configPath, 'utf8');
    expect(raw).toContain('MY_SECRET_KEY');
    expect(raw).toContain('apiKeyEnv');
    expect(raw, 'an inline apiKey must never be written').not.toContain('"apiKey"');
  });
});

describe('contract: re-running setup is how you change things', () => {
  it('prefills from the existing config, so pressing Enter through it changes nothing', async () => {
    const { home, configPath } = freshHome();
    const first = scripted(
      ['claude', 'claude-opus-5', 'claude', 'claude-sonnet-5', 'codex', 'gpt-5.6'],
      [true, true, true, true, true],
    );
    await runSetup({
      homeDir: home, configPath, skipProbe: true, detected: new Set(['claude-code' as never]),
      stdout: () => true, stderr: () => true, ask: first.ask, confirm: first.confirm,
    } as never);
    const before = readFileSync(configPath, 'utf8');

    // Every answer empty === pressing Enter at every prompt.
    const second = scripted([], []);
    const code = await runSetup({
      homeDir: home, configPath, skipProbe: true, detected: new Set(['claude-code' as never]),
      stdout: () => true, stderr: () => true, ask: second.ask, confirm: second.confirm,
    } as never);

    expect(code).toBe(SetupExitCode.SUCCESS);
    expect(readFileSync(configPath, 'utf8'), 'a no-op re-run must be a no-op').toBe(before);
  });

  it('refuses without an interactive terminal instead of hanging on a prompt', async () => {
    const { home, configPath } = freshHome();
    const lines: string[] = [];
    const code = await runSetup({ homeDir: home, configPath, stderr: (s) => { lines.push(s); return true; }, stdout: () => true });
    expect(code).toBe(SetupExitCode.ERR_ABORTED);
    expect(lines.join('')).toMatch(/interactive terminal/);
    expect(existsSync(configPath), 'a refused setup writes nothing').toBe(false);
  });
});
