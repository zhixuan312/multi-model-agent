import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function connectTestClient(opts: { url: string; cwd: string; token?: string }): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
  close: () => Promise<void>;
}> {
  const u = new URL(opts.url);
  u.searchParams.set('cwd', opts.cwd);
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const transport = new StreamableHTTPClientTransport(u, { requestInit: { headers } });
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    transport,
    close: async () => {
      // terminateSession() sends an explicit DELETE so the server-side transport.onclose fires.
      // Plain close() only tears down the local transport — the daemon doesn't learn the session is gone.
      try { await transport.terminateSession(); } catch { /* best-effort */ }
      try { await client.close(); } catch { /* best-effort */ }
      try { await transport.close(); } catch { /* best-effort */ }
    },
  };
}
