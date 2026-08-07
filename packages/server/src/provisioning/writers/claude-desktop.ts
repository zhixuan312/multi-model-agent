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

/** The macOS/Windows path split, separated from {@link resolveClaudeDesktopPath}
 *  only so that function stays a thin defaulting layer over it. */
function resolveClaudeDesktopConfigPath(homeDir: string, platform: string, appData: string): string {
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
 *  never a credential.
 *
 *  Deliberately NOT `--client=claude-desktop`, even though the bridge accepts it
 *  and Desktop would then attribute as itself instead of `other`. `isOwnedMcpEntry`
 *  proves ownership of a stdio entry by requiring args to be EXACTLY
 *  `[entrypoint, 'mcp']` — extra arguments are its evidence that a human edited
 *  the entry, and it fails closed on them. Appending a flag would therefore make
 *  MMA's own registration unrecognisable to MMA: already-installed entries would
 *  stop being updatable or removable, and fixing that would mean either weakening
 *  a fail-closed security check or shipping a migration for prior arg shapes.
 *  Desktop is the one client kept regardless of adoption data, so its attribution
 *  is also the least informative — not worth either price. */
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
