/**
 * opencode registration writer.
 *
 * `~/.config/opencode/opencode.json`. Servers live under the top-level `mcp` key
 * — NOT `mcpServers` — per the verified capability registry row
 * (`mcpTopLevelKey: 'mcp'`), which `registration-writer.ts`'s shared JSON install
 * path reads instead of hardcoding `mcpServers`. Entry shape: `{ type: 'remote',
 * url, headers, enabled: true }`.
 *
 * Secret substitution in headers uses the BRACE-ONLY form `{env:VAR}` — NOT
 * `${env:VAR}`. That distinction is documented on opencode's own Context7
 * example and verified in docs/verification/mcp-client-registration-profiles.md;
 * getting it wrong would send opencode a literal, unresolved string as the
 * credential instead of the daemon's token.
 */
import { join } from 'node:path';
import {
  installJsonClientRegistration,
  type ClientRegistrationResult,
  type WriteClientRegistrationInput,
} from '../registration-writer.js';

/** The path this writer targets, without performing any write. */
export function opencodeRegistrationPath(homeDir: string): string {
  return join(homeDir, '.config', 'opencode', 'opencode.json');
}

export async function writeOpencodeRegistration(input: WriteClientRegistrationInput): Promise<ClientRegistrationResult> {
  const { capability, homeDir, daemonPort } = input;
  const path = opencodeRegistrationPath(homeDir);
  const entry = {
    type: 'remote',
    url: `http://127.0.0.1:${daemonPort}/mcp`,
    headers: {
      Authorization: 'Bearer {env:MMA_AUTH_TOKEN}',
      // Attribution, not auth — see the same header in the Cursor writer.
      'X-MMA-Client': 'opencode',
    },
    enabled: true,
  };
  return installJsonClientRegistration({ capability, path, entry, fs: input.fs });
}
