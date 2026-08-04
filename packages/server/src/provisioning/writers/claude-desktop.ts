/**
 * Claude Desktop registration writer.
 *
 * Claude Desktop is the ONE stdio-bridge client: its entry has no URL at all —
 * `{command: <node execPath>, args: [<abs cli entrypoint>, 'mcp']}` — and its
 * ownership recogniser (`isOwnedMcpEntry` in `../registration-writer.js`) accepts
 * only `command`/`args`. This is also the only writer this task wires into a CLI
 * surface (`mma mcp install`/`mma mcp uninstall`), so it is the only one that
 * exports both an install and a remove function.
 *
 * Path resolution mirrors this repo's Claude Desktop convention since before this
 * writer existed: macOS `~/Library/Application Support/Claude/
 * claude_desktop_config.json`; Windows `%APPDATA%\Claude\claude_desktop_config.json`.
 */
import { join } from 'node:path';
import {
  installJsonClientRegistration,
  removeJsonClientRegistration,
  failedClientRegistrationResult,
  type ClientRegistrationResult,
  type WriteClientRegistrationInput,
} from '../registration-writer.js';

function winJoin(...parts: string[]): string {
  return parts.join('\\').replace(/\\+/g, '\\');
}

/** Test-visible so the CLI's platform/appData context threading can be exercised
 *  directly if ever needed; the writers below are the only real callers. */
export function resolveClaudeDesktopConfigPath(homeDir: string, platform: string, appData: string): string {
  if (platform === 'win32') {
    return winJoin(appData, 'Claude', 'claude_desktop_config.json');
  }
  return join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

/** The path this writer/remover targets, without performing any write. */
export function resolveClaudeDesktopPath(input: WriteClientRegistrationInput): string | undefined {
  const platform = input.platform ?? process.platform;
  const appData = input.appData ?? process.env.APPDATA ?? '';
  if (platform === 'win32' && appData === '') return undefined;
  return resolveClaudeDesktopConfigPath(input.homeDir, platform, appData);
}

/** `command` is the absolute Node binary and `args[0]` the absolute JS
 *  entrypoint — never a bare `mma`, never `npx`, and never a `.js` path as
 *  `command`. A GUI app on macOS does not inherit the shell PATH, and a `.js`
 *  file is not executable as a bare `command` on Windows at all. No `env`, and
 *  never a credential. */
function buildEntry(input: WriteClientRegistrationInput): { command: string; args: string[] } {
  return { command: input.execPath ?? process.execPath, args: [input.cliEntrypoint, 'mcp'] };
}

export async function writeClaudeDesktopRegistration(input: WriteClientRegistrationInput): Promise<ClientRegistrationResult> {
  const { capability } = input;
  const path = resolveClaudeDesktopPath(input);
  if (!path) {
    return failedClientRegistrationResult(
      capability.id,
      '',
      new Error('Claude Desktop registration requires APPDATA on Windows.'),
    );
  }
  const entry = buildEntry(input);
  return installJsonClientRegistration({ capability, path, entry, fs: input.fs });
}

export async function removeClaudeDesktopRegistration(input: WriteClientRegistrationInput): Promise<ClientRegistrationResult> {
  const { capability } = input;
  const path = resolveClaudeDesktopPath(input);
  if (!path) {
    return failedClientRegistrationResult(
      capability.id,
      '',
      new Error('Claude Desktop registration requires APPDATA on Windows.'),
    );
  }
  // The same entrypoint install would write — removal must prove ownership just as
  // strictly, or it could delete another tool's stdio entry that merely looks alike.
  const { args } = buildEntry(input);
  return removeJsonClientRegistration({
    capability,
    path,
    expectedStdioEntrypoint: args[0],
    fs: input.fs,
  });
}
