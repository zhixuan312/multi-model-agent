import { boot, type HarnessHandle } from './harness.js';
import { mockProvider } from './mock-providers.js';
import type { Provider } from '@zhixuan92/multi-model-agent-core';

/**
 * Boot the contract harness with a mock provider.
 *
 * This used to also install a global `fetch` wrapper that (a) rejected a request whose `cwd` did
 * not match the booted server's and (b) reshaped `{ error: { code } }` error bodies into
 * `{ error: code }`. Both branches only fired for `/task` and `/explore` — routes SPEC-003 renamed
 * and retired — so neither had done anything for some time. The reshaping was legacy envelope
 * adaptation besides, which this repo does not keep, and the wrapper replaced `globalThis.fetch`
 * for the whole test process without ever restoring it.
 */
export interface StartTestServerOptions {
  cwd: string;
  /** Override the default mockProvider({ stage: 'ok' }) used by boot(). */
  provider?: Provider;
}

export type TestServerHandle = HarnessHandle;

export async function startTestServer(opts: StartTestServerOptions): Promise<TestServerHandle> {
  return boot({ provider: opts.provider ?? mockProvider({ stage: 'ok' }), cwd: opts.cwd });
}
