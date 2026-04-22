import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function connectTestClient(opts: { url: string; cwd: string; token?: string }): Promise<{
  client: Client;
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
    close: async () => {
      try { await client.close(); } catch { /* best-effort */ }
      try { await transport.close(); } catch { /* best-effort */ }
    },
  };
}
