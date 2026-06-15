/**
 * disabled-state.ts — the persistent "skills disabled" sentinel.
 *
 * `mma disable` writes this file; `sync-skills` (and the npm postinstall
 * hook that shells out to it) consults it so an upgrade never silently
 * reinstalls skills the user deliberately turned off. `mma enable` clears
 * the relevant targets and, when none remain, deletes the file.
 *
 * Stored at ~/.mma/skills-disabled.json — the same directory as the
 * install manifest and auth token, with matching 0o700/0o600 permissions.
 *
 * The sentinel is target-aware: it records *which* clients are disabled so a
 * `disable --target=cursor` does not block syncing claude-code.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { ALL_CLIENTS, manifestDir, type Client } from './manifest.js';

const DISABLED_NAME = 'skills-disabled.json';

// Derive the client enum from ALL_CLIENTS so a new client never silently
// fails sentinel validation. z.enum needs a non-empty literal tuple.
const clientEnum = z.enum(ALL_CLIENTS as unknown as [Client, ...Client[]]);

const disabledStateSchema = z.object({
  version: z.literal(1),
  disabledAt: z.number().int().nonnegative(),
  cliVersion: z.string(),
  targets: z.array(clientEnum),
});

export type DisabledState = z.infer<typeof disabledStateSchema>;

/** Full path to the sentinel file. */
export function disabledStatePath(homeDir?: string): string {
  return path.join(manifestDir(homeDir), DISABLED_NAME);
}

/**
 * Read and validate the sentinel. Returns null when absent, unreadable, or
 * structurally invalid — a malformed sentinel must never wedge sync-skills.
 */
export function readDisabledState(homeDir?: string): DisabledState | null {
  try {
    const raw = fs.readFileSync(disabledStatePath(homeDir), 'utf-8');
    const parsed = disabledStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The set of currently-disabled clients (empty when the sentinel is absent). */
export function disabledTargets(homeDir?: string): Client[] {
  return readDisabledState(homeDir)?.targets ?? [];
}

/**
 * Mark `targets` as disabled, unioned with any already-disabled clients.
 * Returns the resulting disabled set (stable ALL_CLIENTS order).
 */
export function addDisabledTargets(
  homeDir: string | undefined,
  targets: Client[],
  cliVersion: string,
): Client[] {
  const current = new Set(disabledTargets(homeDir));
  for (const t of targets) current.add(t);
  const merged = ALL_CLIENTS.filter((c) => current.has(c));
  writeDisabledState(homeDir, {
    version: 1,
    disabledAt: Date.now(),
    cliVersion,
    targets: merged,
  });
  return merged;
}

/**
 * Clear `targets` from the disabled set. Deletes the sentinel file entirely
 * once nothing remains disabled. Returns the still-disabled set.
 */
export function clearDisabledTargets(homeDir: string | undefined, targets: Client[]): Client[] {
  const existing = readDisabledState(homeDir);
  if (existing === null) return [];

  const remaining = existing.targets.filter((t) => !targets.includes(t));
  if (remaining.length === 0) {
    try {
      fs.rmSync(disabledStatePath(homeDir), { force: true });
    } catch {
      /* best effort — an absent file is the desired end state anyway */
    }
    return [];
  }

  writeDisabledState(homeDir, { ...existing, targets: remaining });
  return remaining;
}

function writeDisabledState(homeDir: string | undefined, state: DisabledState): void {
  fs.mkdirSync(manifestDir(homeDir), { recursive: true, mode: 0o700 });
  fs.writeFileSync(disabledStatePath(homeDir), JSON.stringify(state, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}
