import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_CAPABILITIES } from '../../../packages/server/src/provisioning/capability-registry.js';
import { writeClientRegistration } from '../../../packages/server/src/provisioning/registration-writer.js';

describe('contract: verified registration writers', () => {
  it('writes immediately usable, dynamic-token home registrations for every unblocked client', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mma-writer-'));
    for (const clientId of ['claude-code', 'claude-desktop', 'codex', 'antigravity', 'cursor'] as const) {
      const capability = CLIENT_CAPABILITIES.find((candidate) => candidate.id === clientId)!;
      const result = await writeClientRegistration({ capability, homeDir: home, daemonPort: 7337, cliEntrypoint: '/opt/mma.js' });
      expect(result.status).toBe('registered');
      expect(result.path.startsWith(home)).toBe(true);
      const bytes = await readFile(result.path, 'utf8');
      // Client-SPECIFIC shape. Claude Desktop is a stdio bridge — its entry is
      // { command, args: [entrypoint, 'mcp'] } with no URL at all, and its ownership
      // recogniser rejects any other key. Asserting a loopback URL for every client
      // would contradict this task's own claude-desktop contract.
      if (clientId === 'claude-desktop') {
        expect(bytes).toContain('"mcp"');
        expect(bytes).toContain('/opt/mma.js');
        expect(bytes).not.toContain('127.0.0.1');
      } else {
        expect(bytes).toContain('127.0.0.1');
      }
      expect(bytes).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/);
      await expect(result.initializeOnce()).resolves.toEqual({ ok: true });
    }
  });
});