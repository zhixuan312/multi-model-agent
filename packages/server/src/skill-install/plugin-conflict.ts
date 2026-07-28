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

/** Human-facing warning shown when standalone skills would duplicate the plugin. */
export function pluginConflictWarning(pluginKey: string): string {
  return [
    `warning: the "${pluginKey}" plugin is installed, which already provides these skills`,
    `         as /mma:audit, /mma:delegate, … plus the MCP server.`,
    `         Installing them standalone as well gives you TWO copies of every skill`,
    `         (/mma-audit AND /mma:audit) with near-identical descriptions, so Claude`,
    `         picks between them arbitrarily and the copies drift on the next update.`,
    ``,
    `         Keep ONE:`,
    `           plugin only      → mma disable --target=claude-code`,
    `           standalone only  → claude plugin uninstall ${pluginKey}`,
    ``,
  ].join('\n');
}
