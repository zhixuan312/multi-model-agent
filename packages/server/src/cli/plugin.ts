// `mma plugin build` — generate the Claude Code plugin directory.
//
// One install gives a Claude Code user both the mma skills and the MCP server
// registration. The output is a build artifact regenerated from the packaged
// skills; see plugin/build-plugin.ts for why no auth token is written into it.

import * as os from 'node:os';
import * as path from 'node:path';
import minimist from 'minimist';
import { buildPlugin, PLUGIN_NAME } from '../plugin/build-plugin.js';

interface PluginCliDeps {
  argv: string[];
  version: string;
  /** Daemon port from the loaded config (falls back to the default). */
  port: number;
  homeDir: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const USAGE = `Usage: mma plugin build [--out <dir>] [--port <n>] [--json]

Generate the Claude Code plugin (skills + commands + MCP server registration).

Options:
  --out <dir>   Output directory (default: ~/.mma/plugin)
  --port <n>    Daemon port the MCP entry targets (default: from config)
  --json        Machine-readable output
`;

export function runPlugin(deps: PluginCliDeps): number {
  const opts = minimist(deps.argv, {
    string: ['out'],
    boolean: ['json', 'help'],
    alias: { h: 'help' },
  });

  const sub = String(opts._[0] ?? '');
  if (opts.help || sub === '' || sub === 'help') {
    deps.stdout(USAGE);
    return sub === '' && !opts.help ? 1 : 0;
  }
  if (sub !== 'build') {
    deps.stderr(`mma plugin: unknown subcommand "${sub}"\n\n${USAGE}`);
    return 1;
  }

  const port = opts.port !== undefined ? Number(opts.port) : deps.port;
  if (!Number.isInteger(port) || port <= 0) {
    deps.stderr(`mma plugin build: --port must be a positive integer (got ${String(opts.port)})\n`);
    return 1;
  }

  const outDir = opts.out
    ? path.resolve(String(opts.out))
    : path.join(deps.homeDir, '.mma', 'plugin');

  let result;
  try {
    result = buildPlugin({ outDir, version: deps.version, port });
  } catch (err) {
    deps.stderr(`mma plugin build: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (opts.json) {
    deps.stdout(`${JSON.stringify({
      outDir: result.outDir,
      skills: result.skills,
      commands: result.commands,
      mcpUrl: result.mcpUrl,
      version: deps.version,
    }, null, 2)}\n`);
    return 0;
  }

  deps.stdout(
    `Built plugin "${PLUGIN_NAME}" v${deps.version}\n`
    + `  ${result.outDir}\n`
    + `  ${result.skills.length} skills, ${result.commands.length} commands, MCP -> ${result.mcpUrl}\n`
    + `  no auth token written (headersHelper reads it at connect time)\n\n`
    + `Try it:\n`
    + `  claude --plugin-dir ${result.outDir}\n\n`
    + `Already using \`mma sync-skills\`? Standalone and plugin skills coexist —\n`
    + `run \`mma disable --target=claude-code\` first to avoid duplicates.\n`,
  );
  return 0;
}

/** Default home dir helper so index.ts stays terse. */
function defaultHomeDir(): string {
  return os.homedir();
}
