import { describe, expect, it } from 'vitest';
import { provisioningTestFixture } from '../fixtures/provisioning-fixture.js';
import { CLIENT_IDS } from '../../../packages/core/src/clients/client-id.js';

describe('contract: atomic provisioning and recovery', () => {
  it('rolls back safely, respects shared roots, and recovers an interrupted marker', async () => {
    const fixture = provisioningTestFixture({
      clients: { cursor: 'on', vscode: 'on', codex: 'on', 'claude-desktop': 'on' },
      failRegistrationFor: new Set(['codex']),
    });
    const first = await fixture.provisionAll();
    expect(first.byClient.codex).toMatchObject({ status: 'failed', skillsInstalled: false, mcpRegistrationStatus: 'failed' });
    expect(first.byClient.vscode).toMatchObject({ status: 'provisioned', skillsInstalled: true });
    expect(fixture.installedSkillNames('cursor')).toEqual(fixture.packagedSkillNames());

    fixture.failSkillsFor.add('cursor');
    const second = await fixture.provision(['cursor']);
    expect(second.byClient.cursor).toMatchObject({ status: 'failed', mcpRegistrationStatus: 'absent' });
    expect(fixture.installedSkillNames('vscode')).toEqual(fixture.packagedSkillNames());

    fixture.interruptAfter('registered', 'cursor');
    await expect(fixture.provision(['cursor'])).rejects.toMatchObject({ code: 'interrupted' });
    expect(fixture.marker('cursor')).toMatchObject({ phase: 'registered' });
    expect((await fixture.inventory()).find((r) => r.clientId === 'cursor')).toMatchObject({ mcpRegistrationStatus: 'failed' });
    await fixture.recoverOnStartup();
    expect(fixture.marker('cursor')).toBeNull();

    const records = await fixture.inventory();
    // Every canonical client is reported, named — not merely eight of something.
    expect(records.map((record) => record.clientId)).toEqual([...CLIENT_IDS]);
    expect(records.find((record) => record.clientId === 'claude-desktop')).toMatchObject({ skillsInstalled: false, mcpRegistrationStatus: 'registered' });
  });
});