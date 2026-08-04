/**
 * Antigravity registration writer.
 *
 * `~/.gemini/config/mcp_config.json`, `mcpServers` key. The streamable-HTTP field
 * is `serverUrl` — NOT `url`/`httpUrl` — per the verified capability registry row.
 */
import { join } from 'node:path';
import {
  installJsonClientRegistration,
  type ClientRegistrationResult,
  type WriteClientRegistrationInput,
} from '../registration-writer.js';

export async function writeAntigravityRegistration(input: WriteClientRegistrationInput): Promise<ClientRegistrationResult> {
  const { capability, homeDir, daemonPort } = input;
  const path = join(homeDir, '.gemini', 'config', 'mcp_config.json');
  const entry = {
    serverUrl: `http://127.0.0.1:${daemonPort}/mcp`,
    headers: { Authorization: 'Bearer ${env:MMA_AUTH_TOKEN}' },
  };
  return installJsonClientRegistration({ capability, path, entry, fs: input.fs });
}
