/**
 * Persisting the declared client roster.
 *
 * The roster is the answer to "which clients should MMA provision", and it has
 * to outlive the command that asked — otherwise the next `npm install` cannot
 * refresh anything and the user is back to running commands by hand. One place
 * writes it, shared by `mma sync`'s first-run prompt and by `enable`/`disable`,
 * so those two can never disagree about the file's shape.
 *
 * Creating the file when it is absent is the point of the change that made
 * `agents` optional in the config schema. Before that, a fresh machine could not
 * record a roster at all: the only legal home for it was a file that could not
 * be written until models had been chosen, which is the opposite of the order
 * people actually do things in.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import type { DeclaredClientRoster } from '../provisioning/roster.js';

/**
 * Merge `{ [id]: state }` for every `targets` into `configPath`'s `clients` map,
 * preserving every other key untouched, and creating the file if it is absent.
 *
 * Everything outside `clients` is left exactly as found — this rewrites one key,
 * not the file. A config that is present but not a JSON object is an error
 * rather than something to overwrite: it is the user's file, and replacing it
 * would destroy settings we did not author.
 */
export function persistDeclaredState(configPath: string, targets: readonly ClientId[], state: 'on' | 'off'): void {
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`config file is not a JSON object: ${configPath}`);
    }
    raw = parsed as Record<string, unknown>;
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }
  const existing = typeof raw.clients === 'object' && raw.clients !== null && !Array.isArray(raw.clients)
    ? (raw.clients as Record<string, unknown>)
    : {};
  const nextClients = { ...existing };
  for (const id of targets) nextClients[id] = state;
  fs.writeFileSync(configPath, JSON.stringify({ ...raw, clients: nextClients }, null, 2) + '\n', 'utf-8');
}

/** The roster currently recorded at `configPath`, or `undefined` when there is
 *  nothing readable there. Never throws: a roster we cannot parse is not
 *  evidence about what the user wants. */
export function readDeclaredState(configPath: string): DeclaredClientRoster | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const clients = (parsed as { clients?: unknown }).clients;
    if (typeof clients !== 'object' || clients === null || Array.isArray(clients)) return undefined;
    return clients as DeclaredClientRoster;
  } catch {
    return undefined;
  }
}
