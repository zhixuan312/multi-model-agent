// Plugin-vs-standalone conflict detection for Claude Code.
//
// The mma skills reach Claude Code two ways, and they are NOT mutually
// exclusive:
//
//   1. `mma sync-skills`      → ~/.claude/skills/mma-audit/    → /mma-audit
//   2. the mma plugin         → plugin cache, namespaced       → /mma:audit
//
// Claude Code deliberately keeps both (plugin components are namespaced, so
// nothing overwrites anything). The cost is that a user who did both ends up
// with two skills per capability whose descriptions are near-identical, so
// intent-matching has to pick one arbitrarily, and the two copies drift as
// soon as one side updates.
//
// This module detects the overlap so `sync-skills` can say so plainly instead
// of silently doubling the surface.

import fs from 'node:fs';
import path from 'node:path';

/** Claude Code records installs as `enabledPlugins: { "<plugin>@<marketplace>": true }`. */
export function readEnabledPlugins(homeDir: string): Record<string, boolean> {
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      enabledPlugins?: Record<string, boolean>;
    };
    return parsed.enabledPlugins ?? {};
  } catch {
    return {}; // no settings file, or unreadable/malformed — treat as "no plugins"
  }
}

/**
 * Returns the `<plugin>@<marketplace>` key of an ENABLED mma plugin, or null.
 * Matches on the plugin name (before `@`) so the marketplace can be this repo,
 * a fork, or the community catalog.
 */
export function findEnabledMmaPlugin(homeDir: string): string | null {
  for (const [key, enabled] of Object.entries(readEnabledPlugins(homeDir))) {
    if (enabled && key.split('@')[0] === 'mma') return key;
  }
  return null;
}

/**
 * The version Claude Code currently has installed for `pluginKey`, or null.
 *
 * Read from `~/.claude/plugins/installed_plugins.json`, which records one or
 * more install records per plugin key. The newest by `lastUpdated` is the one
 * in force. Returns null on any missing or malformed input rather than
 * guessing — `mma doctor` reports "unknown" for that, which is honest, whereas
 * a guessed version would be reported as drift or as agreement.
 */
export function readInstalledPluginVersion(homeDir: string, pluginKey: string): string | null {
  try {
    const p = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      plugins?: Record<string, Array<{ version?: string; lastUpdated?: string }>>;
    };
    const records = parsed.plugins?.[pluginKey];
    if (!Array.isArray(records) || records.length === 0) return null;
    const newest = [...records].sort((a, b) =>
      String(b.lastUpdated ?? '').localeCompare(String(a.lastUpdated ?? '')))[0];
    const version = newest?.version;
    // Claude Code writes the literal string "unknown" for plugins whose
    // manifest carried no version. That is not a version.
    return typeof version === 'string' && version !== '' && version !== 'unknown' ? version : null;
  } catch {
    return null;
  }
}

/**
 * Message for the auto-supersede path: the plugin is present, so the standalone
 * Claude Code install is redundant and gets retired.
 *
 * Deliberately one-directional. MMA owns `~/.claude/skills/mma-*` and may clean
 * up its own redundant copies, but it must NEVER uninstall the plugin:
 *   - `sync-skills` runs from npm postinstall, so auto-removing the plugin would
 *     mean `npm i -g @zhixuan92/multi-model-agent@latest` silently deleting a
 *     Claude Code plugin the user chose. A package upgrade must not do that.
 *   - the plugin is a strict SUPERSET (skills + commands + MCP server), so when
 *     both exist the plugin is the one worth keeping.
 * Choosing standalone instead is an explicit user action (uninstall the plugin),
 * not something an upgrade decides.
 */
export function pluginSupersedesMessage(pluginKey: string, removed: number): string {
  return [
    `The "${pluginKey}" plugin already provides these skills (/mma:audit, /mma:delegate, …),`,
    `the SDLC commands, and the MCP server — so the standalone copies are redundant.`,
    removed > 0
      ? `Retired ${removed} standalone Claude Code asset(s) to avoid two copies of every skill.`
      : `Skipping the standalone Claude Code install for the same reason.`,
    // Name BOTH locations. This line used to say only ~/.claude/skills was
    // touched, while the same code path also deletes the standalone command
    // files — so a user who went looking for /mma-flow found it gone and no
    // message accounting for it.
    `Claude Code is unchanged; only MMA's own ~/.claude/skills entries and its`,
    `~/.claude/commands/mma-*.md command files were touched.`,
    ``,
    `  want standalone instead?  claude plugin uninstall ${pluginKey} && mma enable --target=claude-code`,
    `  keep both anyway?         mma sync-skills --target=claude-code --keep-standalone`,
    ``,
  ].join('\n');
}

/** Warning when `mma enable` would recreate the duplicate the plugin supersedes. */
export function enableDespitePluginWarning(pluginKey: string): string {
  return [
    `warning: the "${pluginKey}" plugin is installed and already provides these skills.`,
    `         Installing them standalone as well gives you TWO copies of every skill`,
    `         (/mma-audit AND /mma:audit) with near-identical descriptions, so Claude`,
    `         picks between them arbitrarily. Uninstall the plugin first if you want`,
    `         standalone only: claude plugin uninstall ${pluginKey}`,
    ``,
  ].join('\n');
}
