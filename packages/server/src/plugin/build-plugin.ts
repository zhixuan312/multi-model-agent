// Claude Code plugin builder — emits a self-contained plugin directory that
// carries BOTH the mma skills and the MCP server registration, so a user gets
// the whole surface from one `claude plugin install`.
//
// The plugin is a generated ARTIFACT, never a hand-maintained copy: skills come
// from the same packaged root (`getSkillsRoot`), the same name lists
// (SUPPORTED_SKILLS / SUPPORTED_COMMANDS), and the same `@include _shared/...`
// inlining every other client installer uses. Editing a skill in
// `packages/server/src/skills/` and re-running the build is the only way to
// change plugin content.
//
// Auth: the MCP entry uses `headersHelper` rather than a baked-in token, so no
// secret is ever written into the plugin. The helper reads the daemon's token
// file at connection time, and Claude Code re-runs it automatically on 401/403
// — which also makes token rotation transparent.

import fs from 'node:fs';
import path from 'node:path';
import { AGENT_PLUGIN_CLIENT } from '@zhixuan92/multi-model-agent-core';
import { getSkillsRoot, SUPPORTED_SKILLS, SUPPORTED_COMMANDS, readSkillContent } from '../skill-install/discover.js';
import { inlineIncludes } from '../skill-install/include-utils.js';
import { MCP_TOOLS } from '../mcp/tool-surface.js';

export const PLUGIN_NAME = 'mma';

/**
 * Key for the bundled MCP server inside `.mcp.json`.
 *
 * Claude Code scopes a plugin's server as `<plugin>:<server>` in the UI and as
 * `mcp__plugin_<plugin>_<server>__<tool>` in hook matchers, so naming it `mma`
 * inside plugin `mma` renders "Plugin:mma:mma MCP Server" and
 * `mcp__plugin_mma_mma__mma_run`. `daemon` is both shorter and accurate — it is
 * the local HTTP daemon — giving `mma:daemon`.
 *
 * The TOOL names keep their `mma_` prefix: they are also served over the plain
 * `POST /mcp` endpoint to non-plugin clients, where nothing namespaces them.
 */
export const MCP_SERVER_KEY = 'daemon';

/** The packaging formats this emitter produces. */
export const PLUGIN_TARGETS = ['claude-code', 'agent-plugin'] as const;
export type PluginTarget = typeof PLUGIN_TARGETS[number];

/** Reverse-domain namespace for Claude Code's client extensions inside an
 *  Agent Plugins package. AP assigns no semantics to a namespace's contents,
 *  which is exactly where a Claude-Code-only concept like `commands/` belongs. */
const CLAUDE_CODE_NAMESPACE = 'com.anthropic.claude-code';

/**
 * Per-target layout. Everything ABOVE this table is shared: skill rendering,
 * reference rewriting, manifest metadata, component naming. A target says only
 * WHERE its files go and WHAT its MCP entry looks like — adding a third
 * packaging format is adding a row, never a second emitter.
 */
interface TargetLayout {
  /** Trees replaced wholesale on rebuild so a removed skill cannot linger. */
  generatedDirs: readonly string[];
  manifestPath: string;
  /** Merged BEFORE the shared metadata so `$schema` leads the manifest. */
  manifestPrefix: Record<string, unknown>;
  /** Flat command markdown lands here. */
  commandsDir: string;
  mcpPath: string;
  mcpPrefix: Record<string, unknown>;
  mcpServer: (mcpUrl: string) => Record<string, unknown>;
  /** Only the http transport needs a header helper; stdio resolves its own token. */
  emitsHeadersHelper: boolean;
  /** Human description of how this package reaches the daemon. Plain text —
   *  the README wraps it in backticks, the CLI prints it bare. */
  transportSummary: (mcpUrl: string) => string;
  title: string;
  /** README "Requirements" prose. Owned per target because the transports differ
   *  in what the user must have installed, and in where the token comes from. */
  requirements: string;
  installSection: (outDir: string) => string;
}

const TARGET_LAYOUTS: Readonly<Record<PluginTarget, TargetLayout>> = {
  // Anthropic is not an Agent Plugins participant: Claude Code reads its own
  // manifest path and its own `headersHelper` key, neither of which exists in
  // AP 1.0. This target is therefore frozen in the shape Claude Code already
  // consumes — it is the format that is known to work today.
  'claude-code': {
    generatedDirs: ['skills', 'commands', 'scripts', '.claude-plugin'],
    manifestPath: path.join('.claude-plugin', 'plugin.json'),
    manifestPrefix: {},
    commandsDir: 'commands',
    mcpPath: '.mcp.json',
    mcpPrefix: {},
    // headersHelper (not a static `headers` token): the plugin ships no secret.
    // ${CLAUDE_PLUGIN_ROOT} is quoted because the install path may contain spaces.
    mcpServer: (mcpUrl) => ({
      type: 'http',
      url: mcpUrl,
      headersHelper: '"${CLAUDE_PLUGIN_ROOT}"/scripts/mma-mcp-headers.sh',
    }),
    emitsHeadersHelper: true,
    transportSummary: (mcpUrl) => mcpUrl,
    title: 'Claude Code plugin',
    requirements: `The mma daemon must be running (\`mma serve\`). The plugin contains **no auth
token**: \`scripts/mma-mcp-headers.sh\` reads it at connection time from
\`$MMA_AUTH_TOKEN\`, \`$MMA_TOKEN_FILE\`, or \`~/.mma/auth-token\`.`,
    installSection: (outDir) => `\`\`\`bash
claude --plugin-dir ${outDir}      # try it for one session
\`\`\``,
  },
  // AP 1.0 permits only ${PLUGIN_ROOT}/${PLUGIN_DATA} interpolation, confined to
  // path contexts, and warns that `headers` values are "visible package data,
  // not a portable secret mechanism". So an http entry cannot carry the daemon
  // token. `mma mcp` — the stdio bridge Claude Desktop already uses — resolves
  // the token itself at connect time, which makes stdio both the portable
  // transport AND the one that ships no secret. One file, every AP client.
  'agent-plugin': {
    generatedDirs: ['skills', CLAUDE_CODE_NAMESPACE],
    manifestPath: 'plugin.json',
    manifestPrefix: { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' },
    commandsDir: path.join(CLAUDE_CODE_NAMESPACE, 'commands'),
    mcpPath: 'mcp.json',
    mcpPrefix: { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' },
    // A bare `command` leans on the platform's executable search. AP allows that
    // ("Clients MUST resolve bare names using the platform's executable search
    // rules") while telling conformant plugins not to DEPEND on it — the escape
    // being a bundled, plugin-relative executable. MMA cannot bundle one that is
    // useful: the bridge must reach an already-running daemon installed outside
    // the plugin, so `mma` on PATH is not an extra requirement this package adds,
    // it is the same requirement `mma serve` already imposes. Stating it in the
    // README is honest; shipping a shim that re-resolves the same binary would be
    // a second install path to maintain for no gain.
    mcpServer: () => ({
      type: 'stdio',
      command: 'mma',
      args: ['mcp', `--client=${AGENT_PLUGIN_CLIENT}`],
    }),
    emitsHeadersHelper: false,
    transportSummary: () => `stdio: mma mcp --client=${AGENT_PLUGIN_CLIENT}`,
    title: 'Agent Plugins package',
    requirements: `The mma daemon must be running (\`mma serve\`) and the \`mma\` CLI must be on
PATH — the MCP entry launches it as \`mma mcp\`. The package contains **no auth
token**: the bridge reads it at connection time from \`$MMA_AUTH_TOKEN\`,
\`$MMA_TOKEN_FILE\`, or \`~/.mma/auth-token\`.`,
    installSection: (outDir) => `Install through your client's own plugin mechanism — Agent Plugins 1.0
defines the package format, not an install protocol:

| Client | How |
|---|---|
| VS Code | add \`${outDir}\` to the \`chat.pluginLocations\` setting |
| Cursor | copy (do **not** symlink) into \`~/.cursor/plugins/local/\`, then restart |
| Codex | add a local entry to \`~/.agents/plugins/marketplace.json\`, then \`/plugins\` |`,
  },
};

/**
 * Packaged skill name -> plugin component name.
 *
 * Packaged skills carry an `mma-` prefix because a standalone `sync-skills`
 * install drops them into a FLAT `~/.claude/skills/` shared with every other
 * tool — there, the prefix IS the namespace. A plugin already namespaces every
 * component as `/<plugin>:<component>`, so keeping the prefix would produce
 * `/mma:mma-audit`. Strip it: the directory name is the invocation name, so
 * `audit/` yields `/mma:audit`.
 *
 * The router skill is packaged as `multi-model-agent` (the product name); as a
 * plugin component that reads as `/mma:multi-model-agent`, so it becomes
 * `router` — what it actually is.
 */
export function pluginComponentName(packagedName: string): string {
  if (packagedName === 'multi-model-agent') return 'router';
  return packagedName.startsWith('mma-') ? packagedName.slice('mma-'.length) : packagedName;
}

/**
 * Rewrite cross-skill references in skill prose to the namespaced plugin form:
 * `mma-investigate` -> `mma:investigate`, and `/mma-flow` -> `/mma:flow` (which
 * is the real invocation). Only exact packaged skill names are matched, so
 * unrelated text — `mma serve`, `.mma/plans/`, `mma-parent` — is untouched.
 *
 * The frontmatter `name:` field is NOT handled here; it must be the bare
 * component name and is rewritten separately. The product name
 * `multi-model-agent` is deliberately never rewritten — it appears throughout
 * the prose as the project's name, not as a skill reference.
 */
export function rewriteSkillReferences(content: string, packagedNames: readonly string[]): string {
  const prefixed = packagedNames.filter((n) => n.startsWith('mma-'));
  if (prefixed.length === 0) return content;
  // Longest-first so `mma-journal-record` is never partially matched by a
  // shorter sibling.
  const alternation = [...prefixed]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const renamed = content.replace(
    new RegExp(`(?<![\\w-])(${alternation})(?![\\w-])`, 'g'),
    (match) => `${PLUGIN_NAME}:${match.slice('mma-'.length)}`,
  );
  // `mma-*` is prose shorthand for "the whole skill family"; inside the plugin
  // that family is `mma:*`. Matched separately because `*` is not a skill name.
  return renamed.replace(/(?<![\w-])mma-\*/g, `${PLUGIN_NAME}:*`);
}

/** Replace the frontmatter `name:` value with the bare plugin component name. */
function rewriteFrontmatterName(content: string, componentName: string): string {
  return content.replace(/^(---\r?\n(?:.*\r?\n)*?name:[ \t]*)["']?[^\r\n"']+["']?([ \t]*\r?\n)/,
    `$1${componentName}$2`);
}

/** Emitted at <plugin>/scripts/mma-mcp-headers.sh and referenced by .mcp.json.
 *  Must print a JSON object of string header pairs on stdout (Claude Code
 *  merges it into the connection headers). Prints `{}` when no token is
 *  available so a stopped daemon surfaces as an auth failure, not a crash.
 *
 *  `X-MMA-Client` is the only signal telling the daemon this traffic came from an
 *  Agent Plugins install; without it the call records the anonymous `mcp`. The
 *  value is `agent-plugin`, not `claude-code`, because several clients can load
 *  the plugin and none of them owns it. */
export const HEADERS_HELPER_SH = `#!/usr/bin/env bash
# Supplies the MMA bearer token and client attribution to Claude Code as MCP
# connection headers.
#
# Read at CONNECT time, never stored in the plugin: rotating the token file is
# picked up on the next connection, and Claude Code re-runs this helper
# automatically if a call returns 401/403.
#
# Token resolution order:
#   1. $MMA_AUTH_TOKEN         (env override, matches the daemon's own override)
#   2. $MMA_TOKEN_FILE         (explicit path)
#   3. ~/.mma/auth-token       (default daemon location)
set -uo pipefail

if [ -n "\${MMA_AUTH_TOKEN:-}" ]; then
  token="\$MMA_AUTH_TOKEN"
else
  token_file="\${MMA_TOKEN_FILE:-\$HOME/.mma/auth-token}"
  if [ -r "\$token_file" ]; then
    token="\$(tr -d '\\r\\n' < "\$token_file")"
  else
    # No token available — emit no credential rather than failing the connection,
    # so the user sees an auth error they can act on. The client header carries no
    # secret, so it still goes out.
    printf '{"X-MMA-Client":"agent-plugin"}\\n'
    exit 0
  fi
fi

# JSON-escape the token defensively (a real token is base64url, but never
# hand-build JSON from unvalidated input).
escaped=\$(printf '%s' "\$token" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')
printf '{"Authorization":"Bearer %s","X-MMA-Client":"agent-plugin"}\\n' "\$escaped"
`;

interface BuildPluginOptions {
  /** Directory to write the plugin into. Created if missing; skills/, commands/
   *  and scripts/ inside it are replaced wholesale so stale entries can't survive. */
  outDir: string;
  /** Plugin manifest version — the mma server version it was generated from. */
  version: string;
  /** Daemon port the MCP entry points at. */
  port: number;
  /** Packaging format. Defaults to `claude-code` — the format that predates
   *  this option and the one Claude Code is known to consume, so an existing
   *  caller that never passes a target keeps getting exactly what it got. */
  target?: PluginTarget;
  /** Override the packaged skills root (tests). */
  skillsRoot?: string;
}

interface BuildPluginResult {
  outDir: string;
  target: PluginTarget;
  skills: string[];
  commands: string[];
  /** The daemon endpoint. Reached directly by the http target and through the
   *  stdio bridge by the AP target, but the same endpoint either way. */
  mcpUrl: string;
  /** How this package reaches {@link mcpUrl}, for display. */
  transport: string;
}

function writeFile(target: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
  if (mode !== undefined) fs.chmodSync(target, mode);
}

export function buildPlugin(opts: BuildPluginOptions): BuildPluginResult {
  const skillsRoot = getSkillsRoot(opts.skillsRoot);
  const out = path.resolve(opts.outDir);
  const mcpUrl = `http://127.0.0.1:${opts.port}/mcp`;
  const target = opts.target ?? 'claude-code';
  const layout = TARGET_LAYOUTS[target];

  // Replace generated trees wholesale — a skill removed upstream must not
  // linger in a rebuilt plugin.
  for (const dir of layout.generatedDirs) {
    fs.rmSync(path.join(out, dir), { recursive: true, force: true });
  }
  fs.mkdirSync(out, { recursive: true });

  // ── Manifest ──
  writeFile(path.join(out, layout.manifestPath), `${JSON.stringify({
    ...layout.manifestPrefix,
    name: PLUGIN_NAME,
    description: 'Delegate tool-using work to cost-optimized multi-model agents with cross-model review — skills plus the MMA MCP server.',
    version: opts.version,
    // `claude plugin validate` warns when author is absent; mirrors the npm
    // package's author / homepage / license fields.
    author: { name: 'Zhang Zhixuan', email: 'zhangzhixuan312@gmail.com' },
    homepage: 'https://github.com/zhixuan312/multi-model-agent#readme',
    repository: 'https://github.com/zhixuan312/multi-model-agent',
    license: 'MIT',
  }, null, 2)}\n`);

  // ── Skills (auto-matched by intent) ──
  // No secret can reach this directory: `inlineIncludes` used to take an
  // optional `authToken` that substituted the live token into skill text, and
  // the per-client installers passed it — tolerable for a private
  // `~/.claude/skills/` install, but a plugin is a distributable artifact that
  // may be zipped, published to a marketplace, or committed. That argument no
  // longer exists at all: skills are MCP-only now, so no shipped instruction
  // carries a credential to substitute into in the first place.
  const allPackaged = [...SUPPORTED_SKILLS, ...SUPPORTED_COMMANDS];
  const render = (packagedName: string, raw: string): string => {
    const component = pluginComponentName(packagedName);
    return rewriteFrontmatterName(
      rewriteSkillReferences(inlineIncludes(packagedName, raw, skillsRoot), allPackaged),
      component,
    );
  };

  const skills: string[] = [];
  for (const name of SUPPORTED_SKILLS) {
    const raw = readSkillContent(name, skillsRoot);
    if (raw === null) continue;
    const component = pluginComponentName(name);
    writeFile(path.join(out, 'skills', component, 'SKILL.md'), render(name, raw));
    skills.push(component);
  }

  // ── Commands (explicitly invoked: /mma:flow) ──
  // Flat markdown per the plugin layout; these are user-invoked playbooks, not
  // intent-matched skills.
  const commands: string[] = [];
  for (const name of SUPPORTED_COMMANDS) {
    const raw = readSkillContent(name, skillsRoot);
    if (raw === null) continue;
    const component = pluginComponentName(name);
    writeFile(path.join(out, layout.commandsDir, `${component}.md`), render(name, raw));
    commands.push(component);
  }

  // ── MCP server registration ──
  writeFile(path.join(out, layout.mcpPath), `${JSON.stringify({
    ...layout.mcpPrefix,
    mcpServers: { [MCP_SERVER_KEY]: layout.mcpServer(mcpUrl) },
  }, null, 2)}\n`);

  if (layout.emitsHeadersHelper) {
    writeFile(path.join(out, 'scripts', 'mma-mcp-headers.sh'), HEADERS_HELPER_SH, 0o755);
  }

  // Generated from the real tool surface, never hand-listed: a hand-maintained list silently
  // rots every time a specification adds operations (the record surface added ~70 tools that
  // this README never mentioned until the live smoke caught it).
  const mcpToolList = MCP_TOOLS.map((t) => `\`${t.name}\``).join(', ');
  writeFile(path.join(out, 'README.md'), `# mma — ${layout.title}

Generated by \`mma plugin build\` from multi-model-agent v${opts.version}. Do not
edit by hand: re-run the command to regenerate.

## What it installs

- **${skills.length} skills** — auto-matched by intent (\`/${PLUGIN_NAME}:audit\`, \`/${PLUGIN_NAME}:delegate\`, …)
- **${commands.length} commands** — explicitly invoked (\`/${PLUGIN_NAME}:flow\`, \`/${PLUGIN_NAME}:breakout\`)
- **1 MCP server** (\`${PLUGIN_NAME}:${MCP_SERVER_KEY}\`) — \`${layout.transportSummary(mcpUrl)}\`, exposing ${mcpToolList}

## Requirements

${layout.requirements}

## Install

${layout.installSection(path.relative(process.cwd(), out) || '.')}

## Already using \`mma sync-skills\`?

Standalone skills (\`~/.claude/skills/\`) and plugin skills coexist — you would
see both \`/mma-audit\` and \`/${PLUGIN_NAME}:audit\`. Run \`mma disable --target=claude-code\`
to remove the standalone copies before switching to the plugin.
`);

  return { outDir: out, target, skills, commands, mcpUrl, transport: layout.transportSummary(mcpUrl) };
}
