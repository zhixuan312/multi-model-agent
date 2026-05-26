// Claude native skill delivery. Wraps a staged skills root
// (`<root>/skills/<name>/`) as a local Claude Code plugin so the SDK's
// `plugins` option can load exactly those skills, and builds the matching
// query() options. `settingSources: []` is the SDK's isolation mode — no
// user/project settings leak into the worker.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ClaudeSkillOptions {
  plugins: Array<{ type: 'local'; path: string }>;
  skills: string[];
  settingSources: [];
}

/** Write `<stagedRoot>/.claude-plugin/plugin.json` declaring each staged skill. */
export async function writeClaudePluginWrapper(stagedRoot: string, names: string[]): Promise<void> {
  const pluginDir = join(stagedRoot, '.claude-plugin');
  await mkdir(pluginDir, { recursive: true, mode: 0o700 });
  const manifest = {
    name: 'mma-delegated-skills',
    description: 'Ephemeral skill bundle equipped for this delegate worker.',
    version: '0.0.0',
    skills: names.map((n) => `./skills/${n}`),
  };
  await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
}

export function buildClaudeSkillOptions(stagedRoot: string, names: string[]): ClaudeSkillOptions {
  return {
    plugins: [{ type: 'local', path: stagedRoot }],
    skills: names,
    settingSources: [],
  };
}
