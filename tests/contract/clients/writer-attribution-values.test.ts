/**
 * A registration writer's `X-MMA-Client` value must be one the daemon recognises.
 *
 * `resolveCallerIdentity` checks the header against `CLIENT_ALLOWLIST` and silently resolves
 * anything else to `other`. So a typo in a writer — `windsurff`, `Cursor`, a client id renamed in
 * `CLIENT_IDS` but not here — does not fail, does not warn, and does not appear in any test. It
 * just means every run from that client is attributed to nobody, and the only symptom is a gap in
 * telemetry that shows up weeks later as "why does nothing come from Windsurf".
 *
 * The writers that DON'T set the header are equally deliberate and are asserted here too, so the
 * distinction stays visible:
 *   - `codex` — a direct HTTP MCP registration with no headers mechanism in its TOML entry.
 *     `callerClientFromMeta` prefers the protocol's own `clientInfo` when the client sends it,
 *     yielding `mcp:<name>`; absent that it records the anonymous `mcp`. Either way the writer has
 *     no header to set, which is why it sets none.
 *   - `claude-desktop` — attributes through the stdio bridge's `--client=claude-desktop` flag.
 *   - `claude-code` — installs the shared plugin headers helper, which sends `agent-plugin`
 *     deliberately (several clients can load a plugin and none of them owns it).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLIENT_IDS, AGENT_PLUGIN_CLIENT } from '@zhixuan92/multi-model-agent-core';

const WRITERS_DIR = 'packages/server/src/provisioning/writers';

/** Same set `resolveCallerIdentity` accepts — derived, not restated. */
const RECOGNISED = new Set<string>([...CLIENT_IDS, 'forge', AGENT_PLUGIN_CLIENT]);

/** Writers that deliberately send no `X-MMA-Client`, and how each one attributes instead. */
const ATTRIBUTES_WITHOUT_HEADER: Record<string, string> = {
  'codex.ts': 'no headers mechanism in Codex TOML; attribution comes from MCP clientInfo',
  'claude-desktop.ts': "the bridge's --client=claude-desktop flag",
  'claude-code.ts': "the shared plugin headers helper → 'agent-plugin'",
  'registry.ts': 'not a writer — the dispatch table',
};

const writerFiles = readdirSync(WRITERS_DIR).filter((name) => name.endsWith('.ts'));

/** Every `'X-MMA-Client': '<value>'` literal a writer emits. */
function headerValues(file: string): string[] {
  const text = readFileSync(join(WRITERS_DIR, file), 'utf8');
  return [...text.matchAll(/'X-MMA-Client':\s*'([^']+)'/g)].map((m) => m[1]!);
}

describe('registration writers attribute to a recognised client', () => {
  it('finds the writers', () => {
    expect(writerFiles.length).toBeGreaterThan(4);
  });

  it.each(writerFiles)('%s sends only values the daemon recognises', (file) => {
    for (const value of headerValues(file)) {
      expect(RECOGNISED, `${file} sends X-MMA-Client: '${value}', which resolves to 'other'`).toContain(value);
    }
  });

  it('every writer either sends a header or has a documented reason not to', () => {
    const silent = writerFiles.filter((file) => headerValues(file).length === 0);
    expect(silent.sort()).toEqual(Object.keys(ATTRIBUTES_WITHOUT_HEADER).sort());
  });

  it('a writer that names itself uses its own client id', () => {
    // cursor.ts → 'cursor', windsurf.ts → 'windsurf', opencode.ts → 'opencode'. A writer
    // attributing as a DIFFERENT client would be worse than attributing as nobody.
    for (const file of writerFiles) {
      const values = headerValues(file);
      if (values.length === 0) continue;
      const selfId = file.replace(/\.ts$/, '');
      expect(values, `${file} should attribute as '${selfId}'`).toEqual([selfId]);
    }
  });
});
