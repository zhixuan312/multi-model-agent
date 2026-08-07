// `mma plugin build` — generate the Claude Code plugin directory.
//
// One install gives a Claude Code user both the mma skills and the MCP server
// registration. The output is a build artifact regenerated from the packaged
// skills; see plugin/build-plugin.ts for why no auth token is written into it.

import * as os from 'node:os';
import * as path from 'node:path';
import minimist from 'minimist';
import { buildPlugin, PLUGIN_NAME, PLUGIN_TARGETS, type PluginTarget } from '../plugin/build-plugin.js';

interface PluginCliDeps {
  argv: string[];
  version: string;
  /** Daemon port from the loaded config (falls back to the default). */
  port: number;
  homeDir: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const USAGE = `Usage: mma plugin build [--target <t>] [--out <dir>] [--port <n>] [--json]

Generate a plugin package (skills + commands + MCP server registration) from the
packaged skills.

Options:
  --target <t>  Packaging format: ${PLUGIN_TARGETS.join(' | ')} (default: claude-code)
                  claude-code   .claude-plugin/plugin.json + http MCP entry
                  agent-plugin  Agent Plugins 1.0 — plugin.json + stdio MCP entry
  --out <dir>   Output directory (default: ~/.mma/plugin[-<target>])
  --port <n>    Daemon port the MCP entry targets (default: from config)
  --json        Machine-readable output
`;

export function runPlugin(deps: PluginCliDeps): number {
  const opts = minimist(deps.argv, {
    string: ['out', 'target'],
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

  const target = (opts.target === undefined ? 'claude-code' : String(opts.target)) as PluginTarget;
  if (!(PLUGIN_TARGETS as readonly string[]).includes(target)) {
    deps.stderr(`mma plugin build: unknown --target "${target}". Valid: ${PLUGIN_TARGETS.join(', ')}\n`);
    return 1;
  }

  // Default out dirs are per-target so building both never has one overwrite the
  // other — the two layouts share a root filename (`plugin.json` vs
  // `.claude-plugin/plugin.json`) and stale files from the other target would
  // make a package ambiguous to a client that auto-detects format.
  const outDir = opts.out
    ? path.resolve(String(opts.out))
    : path.join(deps.homeDir, '.mma', target === 'claude-code' ? 'plugin' : `plugin-${target}`);

  let result;
  try {
    result = buildPlugin({ outDir, version: deps.version, port, target });
  } catch (err) {
    deps.stderr(`mma plugin build: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (opts.json) {
    deps.stdout(`${JSON.stringify({
      outDir: result.outDir,
      target: result.target,
      skills: result.skills,
      commands: result.commands,
      mcpUrl: result.mcpUrl,
      transport: result.transport,
      version: deps.version,
    }, null, 2)}\n`);
    return 0;
  }

  deps.stdout(
    `Built ${result.target} package "${PLUGIN_NAME}" v${deps.version}\n`
    + `  ${result.outDir}\n`
    + `  ${result.skills.length} skills, ${result.commands.length} commands, MCP -> ${result.transport}\n`
    + `  no auth token written (resolved at connect time)\n\n`
    + `Try it:\n`
    + `  ${result.target === 'claude-code'
      ? `claude --plugin-dir ${result.outDir}`
      : `see ${result.outDir}/README.md — Agent Plugins defines no install protocol`}\n\n`
    + `Already using \`mma sync-skills\`? Standalone and plugin skills coexist —\n`
    + `run \`mma disable --target=claude-code\` first to avoid duplicates.\n`,
  );
  return 0;
}

/** Default home dir helper so index.ts stays terse. */
function defaultHomeDir(): string {
  return os.homedir();
}
