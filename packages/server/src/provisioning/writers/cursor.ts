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

export async function writeCursorRegistration(input: WriteClientRegistrationInput): Promise<ClientRegistrationResult> {
  const { capability, homeDir, daemonPort } = input;
  const path = join(homeDir, '.cursor', 'mcp.json');
  const entry = {
    url: `http://127.0.0.1:${daemonPort}/mcp`,
    headers: { Authorization: 'Bearer ${env:MMA_AUTH_TOKEN}' },
  };
  return installJsonClientRegistration({ capability, path, entry, fs: input.fs });
}
