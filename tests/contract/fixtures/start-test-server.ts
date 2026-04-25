import { boot, type HarnessHandle } from './harness.js';
import { mockProvider } from './mock-providers.js';

export interface StartTestServerOptions {
  cwd: string;
}

export type TestServerHandle = HarnessHandle;

let fetchWrapped = false;
const allowedCwdsByOrigin = new Map<string, string>();

function installHandlerContractFetchAdapter(): void {
  if (fetchWrapped) return;
  fetchWrapped = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const parsed = new URL(requestUrl);

    if (parsed.pathname === '/investigate') {
      const allowedCwd = allowedCwdsByOrigin.get(parsed.origin);
      const requestCwd = parsed.searchParams.get('cwd');
      if (allowedCwd && requestCwd && requestCwd !== allowedCwd) {
        return new Response(JSON.stringify({ error: 'forbidden_cwd' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    const response = await originalFetch(input, init);
    if (parsed.pathname !== '/investigate') return response;

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json') || response.status < 400) return response;

    const body = await response.clone().json().catch(() => undefined) as { error?: { code?: string; message?: string; details?: unknown } } | undefined;
    if (!body?.error || typeof body.error !== 'object') return response;

    return new Response(JSON.stringify({ error: body.error.code, details: body.error.details }), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof globalThis.fetch;
}

export async function startTestServer(opts: StartTestServerOptions): Promise<TestServerHandle> {
  installHandlerContractFetchAdapter();
  const server = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: opts.cwd });
  allowedCwdsByOrigin.set(server.baseUrl, opts.cwd);
  return {
    ...server,
    async close(): Promise<void> {
      allowedCwdsByOrigin.delete(server.baseUrl);
      await server.close();
    },
  };
}
