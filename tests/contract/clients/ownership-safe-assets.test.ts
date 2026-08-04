import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeSkillDigest, inspectSkillOwnership } from '../../../packages/server/src/provisioning/owned-files.js';
import { writeOwnedRegistration } from '../../../packages/server/src/provisioning/registration-writer.js';

describe('contract: ownership-safe provisioning assets', () => {
  it('uses the canonical digest and refuses unowned or stale registration content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mma-owned-assets-'));
    const rendered = new Map([['SKILL.md', Buffer.from('skill')], ['nested/a.txt', Buffer.from('a')]]);
    const digest = computeSkillDigest(rendered);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(join(root, '.mma-install.json'), JSON.stringify({ release: '5.17.0', sha256: digest }));
    expect(await inspectSkillOwnership(root, rendered, '5.17.0')).toMatchObject({ state: 'owned' });
    await writeFile(join(root, '.mma-install.json'), JSON.stringify({ release: '5.17.0', sha256: '0'.repeat(64) }));
    expect(await inspectSkillOwnership(root, rendered, '5.17.0')).toMatchObject({ state: 'modified-conflict' });

    const config = join(root, 'config.json');
    await writeFile(config, JSON.stringify({ mcpServers: { mma: { url: 'user-owned' } } }));
    await expect(writeOwnedRegistration({ path: config, clientId: 'cursor', entry: { url: 'http://127.0.0.1/mcp' } }))
      .rejects.toMatchObject({ code: 'registration_conflict' });
    expect(await readFile(config, 'utf8')).toContain('user-owned');
  });
});