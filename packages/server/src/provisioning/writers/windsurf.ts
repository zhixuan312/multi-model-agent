/**
 * Windsurf registration writer.
 *
 * `~/.codeium/windsurf/mcp_config.json`. Servers live under `mcpServers`, the
 * default the shared JSON install path already uses. A remote entry keys on
 * `serverUrl` — NOT `url`.
 *
 * Uses `${file:~/.mma/auth-token}` for the Authorization header: Windsurf
 * resolves this at connect time from the token file MMA already owns, so no
 * static secret is serialized and no helper script is needed. `${env:VAR}` also
 * works but would require the user to export a variable before launching
 * Windsurf, so it is the weaker choice and not used here.
 */
import { join } from 'node:path';
import {
  installJsonClientRegistration,
  type ClientRegistrationResult,
  type WriteClientRegistrationInput,
} from '../registration-writer.js';

/** The path this writer targets, without performing any write. */
export function windsurfRegistrationPath(homeDir: string): string {
  return join(homeDir, '.codeium', 'windsurf', 'mcp_config.json');
}

export async function writeWindsurfRegistration(input: WriteClientRegistrationInput): Promise<ClientRegistrationResult> {
  const { capability, homeDir, daemonPort } = input;
  const path = windsurfRegistrationPath(homeDir);
  const entry = {
    serverUrl: `http://127.0.0.1:${daemonPort}/mcp`,
    headers: { Authorization: 'Bearer ${file:~/.mma/auth-token}' },
  };
  return installJsonClientRegistration({ capability, path, entry, fs: input.fs });
}
