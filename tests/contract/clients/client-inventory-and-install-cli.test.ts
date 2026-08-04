import { describe, expect, it } from 'vitest';
import { runClientsCommand, runMcpInstallCommand } from '../../../packages/server/src/cli/clients.js';

describe('contract: client inventory and install CLI', () => {
  it('prints the shared inventory and gates mcp install on the declared roster', async () => {
    const text = await runClientsCommand({ json: false, config: { clients: { cursor: 'off' } } });
    expect(text).toContain('cursor');
    const json = JSON.parse(await runClientsCommand({ json: true, config: { clients: { cursor: 'off' } } }));
    expect(json).toHaveLength(8);

    await expect(runMcpInstallCommand({ clientId: undefined, config: {} })).rejects.toMatchObject({ code: 'client_id_required' });
    await expect(runMcpInstallCommand({ clientId: 'not-a-client', config: {} })).rejects.toMatchObject({ code: 'unknown_client' });
    await expect(runMcpInstallCommand({ clientId: 'cursor', config: { clients: { cursor: 'off' } } }))
      .rejects.toMatchObject({ code: 'client_declared_off' });
  });
});