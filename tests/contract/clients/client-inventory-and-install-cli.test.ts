import { describe, expect, it } from 'vitest';
import { runClientsCommand, runMcpInstallCommand } from '../../../packages/server/src/cli/clients.js';
import { CLIENT_IDS } from '../../../packages/core/src/clients/client-id.js';

describe('contract: client inventory and install CLI', () => {
  it('prints the shared inventory and gates mcp install on the declared roster', async () => {
    const text = await runClientsCommand({ json: false, config: { clients: { cursor: 'off' } } });
    expect(text).toContain('cursor');
    const json = JSON.parse(await runClientsCommand({ json: true, config: { clients: { cursor: 'off' } } }));
    // The ids, not a count of 8: a literal restates a fact CLIENT_IDS owns, and a count cannot
    // tell a missing client from a duplicated one.
    expect(json.map((row: { clientId: string }) => row.clientId)).toEqual([...CLIENT_IDS]);

    await expect(runMcpInstallCommand({ clientId: undefined, config: {} })).rejects.toMatchObject({ code: 'client_id_required' });
    await expect(runMcpInstallCommand({ clientId: 'not-a-client', config: {} })).rejects.toMatchObject({ code: 'unknown_client' });
    await expect(runMcpInstallCommand({ clientId: 'cursor', config: { clients: { cursor: 'off' } } }))
      .rejects.toMatchObject({ code: 'client_declared_off' });
  });
});