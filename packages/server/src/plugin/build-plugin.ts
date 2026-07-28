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
import { getSkillsRoot, SUPPORTED_SKILLS, SUPPORTED_COMMANDS, readSkillContent } from '../skill-install/discover.js';
import { inlineIncludes } from '../skill-install/include-utils.js';

export const PLUGIN_NAME = 'mma';

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
 *  available so a stopped daemon surfaces as an auth failure, not a crash. */
export const HEADERS_HELPER_SH = `#!/usr/bin/env bash
# Supplies the MMA bearer token to Claude Code as MCP connection headers.
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
    # No token available — emit no headers rather than failing the connection,
    # so the user sees an auth error they can act on.
    printf '{}\\n'
    exit 0
  fi
fi

# JSON-escape the token defensively (a real token is base64url, but never
# hand-build JSON from unvalidated input).
escaped=\$(printf '%s' "\$token" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')
printf '{"Authorization":"Bearer %s"}\\n' "\$escaped"
`;

export interface BuildPluginOptions {
  /** Directory to write the plugin into. Created if missing; skills/, commands/
   *  and scripts/ inside it are replaced wholesale so stale entries can't survive. */
  outDir: string;
  /** Plugin manifest version — the mma server version it was generated from. */
  version: string;
  /** Daemon port the MCP entry points at. */
  port: number;
  /** Override the packaged skills root (tests). */
  skillsRoot?: string;
}

export interface BuildPluginResult {
  outDir: string;
  skills: string[];
  commands: string[];
  mcpUrl: string;
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

  // Replace generated trees wholesale — a skill removed upstream must not
  // linger in a rebuilt plugin.
  for (const dir of ['skills', 'commands', 'scripts', '.claude-plugin']) {
    fs.rmSync(path.join(out, dir), { recursive: true, force: true });
  }
  fs.mkdirSync(out, { recursive: true });

  // ── Manifest ──
  writeFile(path.join(out, '.claude-plugin', 'plugin.json'), `${JSON.stringify({
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
  // NOTE: inlineIncludes' optional `authToken` argument is deliberately NOT
  // passed. The per-client installers do pass it, substituting the live token
  // into skill text — fine for a private `~/.claude/skills/` install, but a
  // plugin is a distributable artifact that may be zipped, published to a
  // marketplace, or committed. Omitting it leaves the shell-helper form
  // (`${MMA_AUTH_TOKEN:-$(mma print-token)}`), which resolves at runtime on the
  // user's own machine. No secret is ever written into this directory.
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
    writeFile(path.join(out, 'commands', `${component}.md`), render(name, raw));
    commands.push(component);
  }

  // ── MCP server registration ──
  // headersHelper (not a static `headers` token): the plugin ships no secret.
  // ${CLAUDE_PLUGIN_ROOT} is quoted because the install path may contain spaces.
  writeFile(path.join(out, '.mcp.json'), `${JSON.stringify({
    mcpServers: {
      [PLUGIN_NAME]: {
        type: 'http',
        url: mcpUrl,
        headersHelper: '"${CLAUDE_PLUGIN_ROOT}"/scripts/mma-mcp-headers.sh',
      },
    },
  }, null, 2)}\n`);

  writeFile(path.join(out, 'scripts', 'mma-mcp-headers.sh'), HEADERS_HELPER_SH, 0o755);

  writeFile(path.join(out, 'README.md'), `# mma — Claude Code plugin

Generated by \`mma plugin build\` from multi-model-agent v${opts.version}. Do not
edit by hand: re-run the command to regenerate.

## What it installs

- **${skills.length} skills** — auto-matched by intent (\`/${PLUGIN_NAME}:audit\`, \`/${PLUGIN_NAME}:delegate\`, …)
- **${commands.length} commands** — explicitly invoked (\`/${PLUGIN_NAME}:flow\`, \`/${PLUGIN_NAME}:breakout\`)
- **1 MCP server** — \`${mcpUrl}\`, exposing \`mma_run\`, \`mma_task_get\`, \`mma_task_wait\`, \`mma_task_cancel\`

## Requirements

The mma daemon must be running (\`mma serve\`). The plugin contains **no auth
token**: \`scripts/mma-mcp-headers.sh\` reads it at connection time from
\`$MMA_AUTH_TOKEN\`, \`$MMA_TOKEN_FILE\`, or \`~/.mma/auth-token\`.

## Install

\`\`\`bash
claude --plugin-dir ${out}      # try it for one session
\`\`\`

## Already using \`mma sync-skills\`?

Standalone skills (\`~/.claude/skills/\`) and plugin skills coexist — you would
see both \`/mma-audit\` and \`/${PLUGIN_NAME}:audit\`. Run \`mma disable --target=claude-code\`
to remove the standalone copies before switching to the plugin.
`);

  return { outDir: out, skills, commands, mcpUrl };
}
