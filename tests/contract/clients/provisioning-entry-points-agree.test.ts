/**
 * Both provisioning entry points must leave the same record behind.
 *
 * `mma sync-skills` and `mma mcp install <ClientId>` reach the same
 * `ProvisioningService`, but the install manifest that `cli/serve.ts`'s boot
 * check and `skill-install/skill-drift.ts` read is written by the CLI layer, not
 * by the service. So an entry point that provisions skills without recording
 * them is silently invisible to both — and invisibly so, because
 * `findMissingSkills` returns nothing at all for an empty manifest rather than
 * reporting everything as missing. The user simply never hears that their skills
 * are behind.
 *
 * This became reachable in this release: `mma mcp install` previously wrote a
 * Claude Desktop registration and nothing else, so it had no skills to record.
 */
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMcpInstallCommand } from '../../../packages/server/src/cli/clients.js';
import { listEntries } from '../../../packages/server/src/skill-install/manifest.js';
import { SUPPORTED_SKILLS } from '../../../packages/server/src/skill-install/discover.js';

describe('contract: every provisioning entry point records what it installed', () => {
  it('mma mcp install leaves the manifest the boot check reads', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-entrypoint-home-'));
    const stateDir = join(home, '.mma', 'state');

    const result = await runMcpInstallCommand({
      clientId: 'cursor',
      config: { server: { stateDir } },
      homeDir: home,
    });

    expect(result).toMatchObject({ clientId: 'cursor', status: 'provisioned' });
    // The skills really are on disk...
    expect(existsSync(join(home, '.agents', 'skills', 'mma-audit', 'SKILL.md'))).toBe(true);

    // ...and the manifest knows about them, for every packaged skill, against
    // the client that was actually provisioned.
    const entries = listEntries(home);
    expect(entries.map((e) => e.name).sort()).toEqual([...SUPPORTED_SKILLS].sort());
    for (const entry of entries) {
      expect(entry.targets, `${entry.name} must be recorded against cursor`).toContain('cursor');
      expect(entry.skillVersion, `${entry.name} must record a version`).toMatch(/\S/);
    }
  });

  it('records nothing for a client that has no skills to install', async () => {
    // claude-desktop is `skillPathStrategy: 'none'` — a registration alone is a
    // complete install for it, and recording skills it never received would make
    // the boot check chase files that are not supposed to exist.
    const home = mkdtempSync(join(tmpdir(), 'mma-entrypoint-home-none-'));
    const result = await runMcpInstallCommand({
      clientId: 'claude-desktop',
      config: { server: { stateDir: join(home, '.mma', 'state') } },
      homeDir: home,
    });

    expect(result.status).toBe('provisioned');
    // Asserted through `listEntries` — the reader the boot check itself uses — rather than by
    // poking a manifest path. The previous form was `if (existsSync(path)) { expect(...) }`:
    // a conditional assertion that runs nothing at all when the file is absent, which is also
    // exactly what happens if the manifest ever moves. Absence and emptiness are the same
    // answer to "what did this record?", and this asks that question the way production does.
    expect(listEntries(home)).toEqual([]);
  });
});
