/**
 * Which writer handles which client.
 *
 * This lives beside the writers rather than inside `../registration-writer.ts`
 * for one structural reason: every writer imports the shared ownership-safe
 * machinery from that module, so a dispatch table there would import them right
 * back. The cycle worked — nothing was evaluated at module top level, so ESM
 * resolved it — but "works because of evaluation order" is a property that holds
 * until somebody adds a top-level constant, and `npm run lint:deps` was reporting
 * it seven times over.
 *
 * The dependency direction is now one-way and obvious:
 *
 *     registration-writer.ts   (shared machinery: ownership, stale detection,
 *              ▲                atomic rename, no-static-credential)
 *              │
 *          writers/*.ts        (per-client entry shape + path)
 *              ▲
 *              │
 *        writers/registry.ts   (which writer, for which client)
 *
 * Adding a client is adding a row here plus its writer module — the same shape
 * as adding a capability-registry row, and still never a `switch`.
 */
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import {
  failedClientRegistrationResult,
  removeJsonClientRegistration,
  type ClientRegistrationResult,
  type WriteClientRegistrationInput,
} from '../registration-writer.js';
import { claudeCodeRegistrationPath, writeClaudeCodeRegistration } from './claude-code.js';
import { removeClaudeDesktopRegistration, writeClaudeDesktopRegistration } from './claude-desktop.js';
import { codexRegistrationPath, removeCodexRegistration, writeCodexRegistration } from './codex.js';
import { cursorRegistrationPath, writeCursorRegistration } from './cursor.js';
import { opencodeRegistrationPath, writeOpencodeRegistration } from './opencode.js';
import { windsurfRegistrationPath, writeWindsurfRegistration } from './windsurf.js';

type ClientRegistrationFn = (input: WriteClientRegistrationInput) => Promise<ClientRegistrationResult>;

const UNBLOCKED_WRITERS: Partial<Record<ClientId, ClientRegistrationFn>> = {
  'claude-code': writeClaudeCodeRegistration,
  'claude-desktop': writeClaudeDesktopRegistration,
  codex: writeCodexRegistration,
  cursor: writeCursorRegistration,
  opencode: writeOpencodeRegistration,
  windsurf: writeWindsurfRegistration,
};

/** Every non-stdio writer's remove path is the same shared JSON removal
 *  machinery, just pointed at that writer's own resolved path -- no
 *  per-client removal logic beyond "where is the file". */
function jsonRemover(resolvePath: (homeDir: string) => string): ClientRegistrationFn {
  return (input) => removeJsonClientRegistration({ capability: input.capability, path: resolvePath(input.homeDir), fs: input.fs });
}

const UNBLOCKED_REMOVERS: Partial<Record<ClientId, ClientRegistrationFn>> = {
  'claude-code': jsonRemover(claudeCodeRegistrationPath),
  'claude-desktop': removeClaudeDesktopRegistration,
  codex: removeCodexRegistration,
  cursor: jsonRemover(cursorRegistrationPath),
  opencode: jsonRemover(opencodeRegistrationPath),
  windsurf: jsonRemover(windsurfRegistrationPath),
};

/**
 * Install `capability`'s recognised home-level MMA MCP entry by dispatching to its
 * registered writer — the registry above, not a target switch, selects which one
 * runs. A client with no writer returns `failed` rather than throwing. Two are
 * writer-less today, both because no verified path exists: VS Code, whose vendor
 * does not publish a user-level path, and Antigravity, whose vendor retired the
 * path this repo had verified. Both carry `mcpConfigPaths: []`.
 */
export async function writeClientRegistration(input: WriteClientRegistrationInput): Promise<ClientRegistrationResult> {
  const writer = UNBLOCKED_WRITERS[input.capability.id];
  if (!writer) {
    return failedClientRegistrationResult(
      input.capability.id,
      '',
      new Error(`No registration writer is available yet for client '${input.capability.id}'.`),
    );
  }
  return writer(input);
}

/**
 * The registered writer function for `clientId`, or `undefined` when none exists
 * yet — the checkable signal the evidence gate relies on. A client stays
 * writer-less until its profile in `docs/verification/
 * mcp-client-registration-profiles.md` is VERIFIED; `vscode` and `antigravity`
 * remain undefined here because their profiles are BLOCKED (see the capability
 * registry's `mcpConfigPaths: []` for the same signal from the other direction).
 */
export function writerForClient(clientId: ClientId): ClientRegistrationFn | undefined {
  return UNBLOCKED_WRITERS[clientId];
}

/** Remove the capability-selected registration when that writer supports removal. */
export async function removeClientRegistration(input: WriteClientRegistrationInput): Promise<ClientRegistrationResult> {
  const remover = UNBLOCKED_REMOVERS[input.capability.id];
  if (!remover) {
    return failedClientRegistrationResult(
      input.capability.id,
      '',
      new Error(`No registration remover is available yet for client '${input.capability.id}'.`),
    );
  }
  return remover(input);
}
