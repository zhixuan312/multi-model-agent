/**
 * Every declared plain-log kind must have a production emitter.
 *
 * Eight of thirteen kinds had none — `server_started`, `server_stopped`, `request_received`,
 * `request_spilled`, `project_evicted`, `stall_watchdog_armed`, `stall_watchdog_fired`,
 * `server_error`. Three separate tests "covered" the list and not one of them could see it:
 * two asserted `toHaveLength(13)` (a count is satisfied by any thirteen names), and the third
 * emitted the dead names ITSELF before checking they validated, which is an assertion over its
 * own input. The vocabulary an operator greps in `~/.mma/logs` advertised eight events that
 * could never appear.
 *
 * A count cannot distinguish a live name from a dead one. Reachability can: search the
 * production sources for the kind as an emitted string literal, the same way the engine would
 * have to write it to emit it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlainLogKindEnum } from '../../packages/core/src/events/plain-log-entry.js';

const SOURCE_ROOTS = ['packages/core/src', 'packages/server/src'];
/** The declaration site itself — naming a kind here is what makes it declared, not emitted. */
const DECLARATION = 'packages/core/src/events/plain-log-entry.ts';

function sources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && path !== DECLARATION ? [path] : [];
  });
}

const PRODUCTION = SOURCE_ROOTS.flatMap(sources).map((file) => readFileSync(file, 'utf8'));

describe('plain-log kinds are reachable', () => {
  it.each(PlainLogKindEnum.options)('%s is emitted by production code', (kind) => {
    // As a string literal — `kind: 'batch_failed'` — because that is the only way the engine
    // puts one on the bus. A mention in a comment is not an emitter.
    const literal = `'${kind}'`;
    expect(
      PRODUCTION.some((text) => text.includes(literal)),
      `plain-log kind "${kind}" is declared but never emitted — delete it or emit it`,
    ).toBe(true);
  });

  it('the manifest golden lists exactly the declared kinds, both directions', () => {
    // The old manifest test checked manifest ⊆ enum and separately compared lengths. Two
    // one-directional checks plus a count is not the same as set equality: it is satisfied by
    // any manifest whose entries all exist in the enum and whose size happens to match.
    const manifest = JSON.parse(readFileSync('tests/contract/goldens/observability/event-manifest.json', 'utf8')) as {
      kinds: { kind: string }[];
    };
    expect(manifest.kinds.map((k) => k.kind).sort()).toEqual([...PlainLogKindEnum.options].sort());
  });
});
