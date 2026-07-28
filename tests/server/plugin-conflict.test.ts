// Plugin-vs-standalone conflict detection.
//
// Claude Code keeps BOTH copies when a user has run `mma sync-skills` AND
// installed the plugin — plugin components are namespaced, so nothing
// overwrites anything. The result is two skills per capability with
// near-identical descriptions. This must be detected and reported, never
// silently doubled.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findEnabledMmaPlugin,
  readEnabledPlugins,
  pluginConflictWarning,
} from '../../packages/server/src/skill-install/plugin-conflict.js';

function homeWith(settings: unknown | null): string {
  const home = mkdtempSync(join(tmpdir(), 'mma-conflict-'));
  if (settings !== null) {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  }
  return home;
}

describe('plugin conflict detection', () => {
  const homes: string[] = [];
  const mk = (s: unknown | null) => { const h = homeWith(s); homes.push(h); return h; };
  afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

  it('finds an enabled mma plugin regardless of which marketplace shipped it', () => {
    expect(findEnabledMmaPlugin(mk({ enabledPlugins: { 'mma@multi-model-agent': true } })))
      .toBe('mma@multi-model-agent');
    // A fork or the community catalog must match too — the plugin NAME is the key.
    expect(findEnabledMmaPlugin(mk({ enabledPlugins: { 'mma@claude-community': true } })))
      .toBe('mma@claude-community');
  });

  it('ignores a disabled mma plugin and unrelated plugins', () => {
    expect(findEnabledMmaPlugin(mk({ enabledPlugins: { 'mma@multi-model-agent': false } }))).toBeNull();
    expect(findEnabledMmaPlugin(mk({ enabledPlugins: { 'superpowers@claude-plugins-official': true } }))).toBeNull();
    // Not a substring match: a different plugin whose name merely contains "mma".
    expect(findEnabledMmaPlugin(mk({ enabledPlugins: { 'mma-extras@x': true } }))).toBeNull();
  });

  it('treats a missing or malformed settings file as "no plugins" rather than throwing', () => {
    expect(findEnabledMmaPlugin(mk(null))).toBeNull();
    const home = mk(null);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
    expect(() => readEnabledPlugins(home)).not.toThrow();
    expect(findEnabledMmaPlugin(home)).toBeNull();
  });

  it('warns with both concrete remediations, not just a description of the problem', () => {
    const w = pluginConflictWarning('mma@multi-model-agent');
    expect(w).toContain('mma disable --target=claude-code');
    expect(w).toContain('claude plugin uninstall mma@multi-model-agent');
    expect(w).toMatch(/\/mma-audit AND \/mma:audit/);
  });
});
