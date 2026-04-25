import { boot, type HarnessHandle } from './harness.js';
import { mockProvider } from './mock-providers.js';

export interface StartTestServerOptions {
  cwd: string;
}

export type TestServerHandle = HarnessHandle;

export async function startTestServer(opts: StartTestServerOptions): Promise<TestServerHandle> {
  return boot({ provider: mockProvider({ stage: 'ok' }), cwd: opts.cwd });
}
