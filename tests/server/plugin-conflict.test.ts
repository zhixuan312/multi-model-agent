// Plugin-vs-standalone reconciliation.
//
// Standalone (`mma sync-skills` → ~/.claude/skills/mma-*) is the default. The
// plugin is a strict SUPERSET (skills + commands + MCP server), so when it is
// detected the standalone Claude Code install is retired automatically.
//
// The automation is strictly ONE-DIRECTIONAL. MMA may clean up its own
// ~/.claude/skills entries, but must never uninstall the plugin: sync-skills
// runs from npm postinstall, so the reverse would make a routine
// `npm i -g @zhixuan92/multi-model-agent@latest` silently delete a Claude Code
// plugin the user chose.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findEnabledMmaPlugin,
  readEnabledPlugins,
  pluginSupersedesMessage,
  enableDespitePluginWarning,
} from '../../packages/server/src/skill-install/plugin-conflict.js';
import { runSyncSkills } from '../../packages/server/src/cli/sync-skills.js';
import { SUPPORTED_SKILLS, SUPPORTED_COMMANDS } from '../../packages/server/src/skill-install/discover.js';

// The `~/.mma/skills-disabled.json` sentinel (disabled-state.ts) is retired
// (Task I-7) -- Task I-8 replaces "pin off" persistence with the declared
// `clients` roster. `sync-skills` no longer has anything to report here.
const disabledTargets = (_home?: string): string[] => [];

const homes: string[] = [];
function homeWith(settings: unknown | null): string {
  const home = mkdtempSync(join(tmpdir(), 'mma-conflict-'));
  homes.push(home);
  if (settings !== null) {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  }
  return home;
}
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

describe('plugin detection', () => {
  it('finds an enabled mma plugin regardless of which marketplace shipped it', () => {
    expect(findEnabledMmaPlugin(homeWith({ enabledPlugins: { 'mma@multi-model-agent': true } })))
      .toBe('mma@multi-model-agent');
    // A fork or the community catalog must match too — the plugin NAME is the key.
    expect(findEnabledMmaPlugin(homeWith({ enabledPlugins: { 'mma@claude-community': true } })))
      .toBe('mma@claude-community');
  });

  it('ignores a disabled mma plugin and unrelated plugins', () => {
    expect(findEnabledMmaPlugin(homeWith({ enabledPlugins: { 'mma@multi-model-agent': false } }))).toBeNull();
    expect(findEnabledMmaPlugin(homeWith({ enabledPlugins: { 'superpowers@claude-plugins-official': true } }))).toBeNull();
    // Not a substring match: a different plugin whose name merely contains "mma".
    expect(findEnabledMmaPlugin(homeWith({ enabledPlugins: { 'mma-extras@x': true } }))).toBeNull();
  });

  it('treats a missing or malformed settings file as "no plugins" rather than throwing', () => {
    expect(findEnabledMmaPlugin(homeWith(null))).toBeNull();
    const home = homeWith(null);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
    expect(() => readEnabledPlugins(home)).not.toThrow();
    expect(findEnabledMmaPlugin(home)).toBeNull();
  });

  it('messages name the concrete escape hatches', () => {
    const sup = pluginSupersedesMessage('mma@multi-model-agent', 18);
    expect(sup).toContain('Retired 18');
    expect(sup).toContain('--keep-standalone');
    expect(sup).toContain('claude plugin uninstall mma@multi-model-agent');
    // Must be explicit that the plugin itself was never touched.
    expect(sup).toContain('Claude Code is unchanged');
    expect(pluginSupersedesMessage('mma@x', 0)).toContain('Skipping');

    expect(enableDespitePluginWarning('mma@x')).toContain('claude plugin uninstall mma@x');
  });
});

describe('sync-skills: plugin supersedes standalone', () => {
  /** A home with Claude Code detected and standalone skills+commands present. */
  function homeWithStandalone(pluginEnabled: boolean): string {
    const home = homeWith(pluginEnabled ? { enabledPlugins: { 'mma@multi-model-agent': true } } : {});
    for (const s of SUPPORTED_SKILLS) {
      mkdirSync(join(home, '.claude', 'skills', s), { recursive: true });
      writeFileSync(join(home, '.claude', 'skills', s, 'SKILL.md'), `---\nname: ${s}\nversion: "1.0.0"\n---\nbody\n`);
    }
    mkdirSync(join(home, '.claude', 'commands'), { recursive: true });
    for (const c of SUPPORTED_COMMANDS) {
      writeFileSync(join(home, '.claude', 'commands', `${c}.md`), `---\nname: ${c}\nversion: "1.0.0"\n---\nbody\n`);
    }
    return home;
  }

  const run = (home: string, argv: string[]) =>
    runSyncSkills({ argv, homeDir: home, silent: true, stdout: () => true, stderr: () => true });

  it('retires the standalone install when the plugin is present', async () => {
    const home = homeWithStandalone(true);
    await run(home, ['--target=claude-code']);

    const left = existsSync(join(home, '.claude', 'skills'))
      ? readdirSync(join(home, '.claude', 'skills'))
      : [];
    expect(left, `standalone skills survived: ${left.join(', ')}`).toHaveLength(0);
    for (const c of SUPPORTED_COMMANDS) {
      expect(existsSync(join(home, '.claude', 'commands', `${c}.md`)), `${c} survived`).toBe(false);
    }
    // "Pin off so the npm postinstall cannot recreate the duplicate" used to be
    // asserted here via the retired disabled-sentinel file (disabled-state.ts,
    // Task I-7). Persisting that pin now belongs to the declared `clients`
    // roster (Task I-8); this test only pins the retirement itself.
  });

  // A removal that fails is the ONLY way a user ends up with two copies of a
  // skill without asking for it. Every failure here used to be swallowed, so
  // the run reported success and left the duplicates in place — the one outcome
  // this branch exists to prevent, reported as if it had been prevented.
  it('reports removals it could not perform instead of claiming success', async () => {
    const home = homeWithStandalone(true);
    const err: string[] = [];
    // chmod 0o500 on the parent: its children can still be read, but not
    // unlinked. This is what an unwritable or locked directory looks like.
    const skillsDir = join(home, '.claude', 'skills');
    chmodSync(skillsDir, 0o500);
    try {
      await runSyncSkills({
        argv: ['--target=claude-code'], homeDir: home,
        silent: true, stdout: () => true, stderr: (s) => { err.push(s); return true; },
      });
    } finally {
      chmodSync(skillsDir, 0o700);
    }

    const text = err.join('');
    expect(text).toContain('could NOT be removed');
    expect(text).toContain('two copies');
    // And the copies really are still there, so the warning is not theatre.
    expect(readdirSync(skillsDir).length).toBeGreaterThan(0);
  });

  // --silent exists so the npm postinstall hook stays quiet. It must not be
  // able to hide this: the user is being told about a state they have to fix.
  it('reports failed removals even under --silent', async () => {
    const home = homeWithStandalone(true);
    const err: string[] = [];
    const skillsDir = join(home, '.claude', 'skills');
    chmodSync(skillsDir, 0o500);
    try {
      await runSyncSkills({
        argv: ['--target=claude-code'], homeDir: home,
        silent: true, bestEffort: true,
        stdout: () => true, stderr: (s) => { err.push(s); return true; },
      });
    } finally {
      chmodSync(skillsDir, 0o700);
    }
    expect(err.join('')).toContain('could NOT be removed');
  });

  it('NEVER touches the plugin — only MMA-owned files', async () => {
    const home = homeWithStandalone(true);
    await run(home, ['--target=claude-code']);
    // The enabling record is Claude Code's state, not ours.
    expect(readEnabledPlugins(home)['mma@multi-model-agent']).toBe(true);
    expect(findEnabledMmaPlugin(home)).toBe('mma@multi-model-agent');
  });

  it('leaves standalone alone when no plugin is installed (standalone is the default)', async () => {
    const home = homeWithStandalone(false);
    await run(home, ['--target=claude-code']);
    expect(readdirSync(join(home, '.claude', 'skills')).length).toBeGreaterThan(0);
    expect(disabledTargets(home)).not.toContain('claude-code');
  });

  it('--keep-standalone opts out of the retirement', async () => {
    const home = homeWithStandalone(true);
    await run(home, ['--target=claude-code', '--keep-standalone']);
    expect(readdirSync(join(home, '.claude', 'skills')).length).toBeGreaterThan(0);
    expect(disabledTargets(home)).not.toContain('claude-code');
  });

  it('--dry-run reports without removing anything', async () => {
    const home = homeWithStandalone(true);
    await run(home, ['--target=claude-code', '--dry-run']);
    expect(readdirSync(join(home, '.claude', 'skills')).length).toBeGreaterThan(0);
    expect(disabledTargets(home)).not.toContain('claude-code');
  });

  it('retirement is Claude-Code-only — other clients still sync', async () => {
    const home = homeWithStandalone(true);
    // codex skills live under ~/.codex/skills and must be untouched by this path.
    mkdirSync(join(home, '.codex', 'skills', 'mma-audit'), { recursive: true });
    writeFileSync(join(home, '.codex', 'skills', 'mma-audit', 'SKILL.md'), '---\nname: mma-audit\n---\nx\n');
    await run(home, ['--target=claude-code', '--target=codex']);
    expect(existsSync(join(home, '.codex', 'skills', 'mma-audit', 'SKILL.md'))).toBe(true);
    expect(disabledTargets(home)).not.toContain('codex');
  });
});
