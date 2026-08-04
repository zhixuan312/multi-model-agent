/**
 * Claude Code registration writer.
 *
 * Renders MMA's MCP entry in the plugin `.mcp.json` shape — `{type: 'http', url,
 * headersHelper}` — and installs it at the same default location `mma plugin
 * build` uses (`~/.mma/plugin`), so a bare `claude --plugin-dir ~/.mma/plugin`
 * picks up whatever this writer produces. That directory is entirely MMA's own:
 * unlike the other clients' shared config files, there is no unrelated user
 * content at risk beyond the single `mcpServers.mma` entry the shared
 * ownership-safe writer already protects.
 *
 * Never a static `headers` token: the helper script reads the daemon's token
 * file at CONNECT time (see `plugin/build-plugin.ts`'s `HEADERS_HELPER_SH`,
 * reused here verbatim rather than duplicated).
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEADERS_HELPER_SH } from '../../plugin/build-plugin.js';
import {
  failedClientRegistrationResult,
  installJsonClientRegistration,
  type ClientRegistrationResult,
  type WriteClientRegistrationInput,
} from '../registration-writer.js';

/** Referenced verbatim inside the rendered entry — Claude Code substitutes
 *  `${CLAUDE_PLUGIN_ROOT}` for the plugin's own install directory at connect
 *  time, so the reference is correct no matter where the plugin ends up
 *  installed from. Matches `plugin/build-plugin.ts`'s own `.mcp.json` entry. */
const HEADERS_HELPER_REFERENCE = '"${CLAUDE_PLUGIN_ROOT}"/scripts/mma-mcp-headers.sh';

export async function writeClaudeCodeRegistration(input: WriteClientRegistrationInput): Promise<ClientRegistrationResult> {
  const { capability, homeDir, daemonPort } = input;
  const pluginDir = join(homeDir, '.mma', 'plugin');
  const scriptsDir = join(pluginDir, 'scripts');
  const path = join(pluginDir, '.mcp.json');
  const entry = {
    type: 'http',
    url: `http://127.0.0.1:${daemonPort}/mcp`,
    headersHelper: HEADERS_HELPER_REFERENCE,
  };

  try {
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'mma-mcp-headers.sh'), HEADERS_HELPER_SH, 'utf-8');
    chmodSync(join(scriptsDir, 'mma-mcp-headers.sh'), 0o755);
  } catch (err) {
    return failedClientRegistrationResult(capability.id, path, err);
  }

  return installJsonClientRegistration({ capability, path, entry, fs: input.fs });
}
