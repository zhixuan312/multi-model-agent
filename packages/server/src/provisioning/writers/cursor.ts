/**
 * Cursor registration writer.
 *
 * `~/.cursor/mcp.json`, `{url, headers}`. Credentials are never baked in: the
 * `Authorization` header uses Cursor's own `${env:NAME}` interpolation, resolved
 * from the user's environment at connect time rather than serialized here.
 */
import { join } from 'node:path';
import {
  installJsonClientRegistration,
  type ClientRegistrationResult,
  type WriteClientRegistrationInput,
} from '../registration-writer.js';

/** The path this writer targets, without performing any write. */
export function cursorRegistrationPath(homeDir: string): string {
  return join(homeDir, '.cursor', 'mcp.json');
}

export async function writeCursorRegistration(input: WriteClientRegistrationInput): Promise<ClientRegistrationResult> {
  const { capability, homeDir, daemonPort } = input;
  const path = cursorRegistrationPath(homeDir);
  const entry = {
    url: `http://127.0.0.1:${daemonPort}/mcp`,
    headers: {
      Authorization: 'Bearer ${env:MMA_AUTH_TOKEN}',
      // Attribution, not auth: HTTP MCP carries no other signal of which client
      // is calling, so without this header the run records the anonymous `mcp`.
      'X-MMA-Client': 'cursor',
    },
  };
  return installJsonClientRegistration({ capability, path, entry, fs: input.fs });
}
