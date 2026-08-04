import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_CAPABILITIES } from '../../../packages/server/src/provisioning/capability-registry.js';
import { writeClientRegistration, writerForClient } from '../../../packages/server/src/provisioning/writers/registry.js';
import { CLIENT_IDS } from '@zhixuan92/multi-model-agent-core';

/**
 * Every unblocked writer's exact wire shape.
 *
 * "Contains 127.0.0.1" is not a contract: it passes whether the key is `url` or
 * `serverUrl`, and whether the credential placeholder is the brace-only `{env:VAR}`
 * or the dollar-brace `${env:VAR}`. Those distinctions are precisely what each
 * client's own documentation pins down (see docs/verification/
 * mcp-client-registration-profiles.md) and precisely what a silent regression would
 * break — the file would still be written, still look right, and simply never
 * connect. So each row below states the client's own keys and its own credential
 * syntax.
 */
const EXPECTED: ReadonlyArray<{
  clientId: (typeof CLIENT_IDS)[number];
  /** The key carrying the endpoint. `serverUrl` and `url` are NOT interchangeable. */
  urlKey: 'url' | 'serverUrl' | null;
  /** Exact credential placeholder the client resolves at connect time, if any. */
  credential: string | null;
}> = [
  { clientId: 'claude-code', urlKey: 'url', credential: null },       // headersHelper script, no header literal
  { clientId: 'claude-desktop', urlKey: null, credential: null },     // stdio bridge: command/args, no URL at all
  { clientId: 'codex', urlKey: 'url', credential: null },             // TOML bearer_token_env_var, not a header
  { clientId: 'antigravity', urlKey: 'serverUrl', credential: 'Bearer ${env:MMA_AUTH_TOKEN}' },
  { clientId: 'cursor', urlKey: 'url', credential: 'Bearer ${env:MMA_AUTH_TOKEN}' },
  { clientId: 'opencode', urlKey: 'url', credential: 'Bearer {env:MMA_AUTH_TOKEN}' },
  { clientId: 'windsurf', urlKey: 'serverUrl', credential: 'Bearer ${file:~/.mma/auth-token}' },
];

describe('contract: verified registration writers', () => {
  // A writer added without a row here would ship an unasserted wire shape.
  it('covers every client that has a writer', () => {
    const withWriters = CLIENT_IDS.filter((id) => writerForClient(id) !== undefined);
    expect([...withWriters].sort()).toEqual(EXPECTED.map((row) => row.clientId).sort());
  });

  it.each(EXPECTED)('writes $clientId\'s own documented entry shape with a dynamic credential', async (row) => {
    const home = await mkdtemp(join(tmpdir(), 'mma-writer-'));
    const capability = CLIENT_CAPABILITIES.find((candidate) => candidate.id === row.clientId)!;
    const result = await writeClientRegistration({ capability, homeDir: home, daemonPort: 7337, cliEntrypoint: '/opt/mma.js' });

    expect(result.status).toBe('registered');
    expect(result.path.startsWith(home)).toBe(true);
    const bytes = await readFile(result.path, 'utf8');

    if (row.urlKey === null) {
      // Claude Desktop is a stdio bridge — its entry is { command, args: [entrypoint,
      // 'mcp'] } with no URL at all, and its ownership recogniser rejects any other
      // key. Asserting a loopback URL here would contradict its own contract.
      expect(bytes).toContain('"mcp"');
      expect(bytes).toContain('/opt/mma.js');
      expect(bytes).not.toContain('127.0.0.1');
    } else {
      expect(bytes).toContain(`${row.urlKey}`);
      expect(bytes).toContain('http://127.0.0.1:7337/mcp');
      // The wrong key would still be a syntactically fine config that never connects.
      const wrongKey = row.urlKey === 'url' ? 'serverUrl' : 'url';
      expect(bytes, `${row.clientId} must use "${row.urlKey}", never "${wrongKey}"`).not.toContain(wrongKey);
    }

    if (row.credential !== null) expect(bytes).toContain(row.credential);
    // Whatever the mechanism, a resolved secret must never be serialized.
    expect(bytes).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/);
    await expect(result.initializeOnce()).resolves.toEqual({ ok: true });
  });
});
