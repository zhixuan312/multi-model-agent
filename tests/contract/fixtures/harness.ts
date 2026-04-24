// In-process HTTP harness for contract tests.
//
// Server API inspected from packages/server/src/http/server.ts on 2026-04-24:
//   - Export: `startServer(config: ServerConfig): Promise<RunningServer>`
//     (packages/server/src/http/server.ts:134)
//   - RunningServer has: { port, serverAddress, stop(), batchRegistry,
//     projectRegistry, serverStartedAt } (line 31)
//   - Listen: `server.listen(config.server.port, config.server.bind, resolve)`
//     with `port: 0` for OS-assigned port (line 186)
//   - Token loaded from `config.server.auth.tokenFile` (line 135) — so the
//     harness must write a temp token file, or we add a config knob that
//     accepts an inline token.
//   - Provider injection: NONE. createProvider(slot, config) in
//     packages/core/src/provider.ts:4 reads only `config.agents[slot]`, and
//     is called from execution-context.ts:62 via `providerFactory` inside
//     the ExecutionContext. There's no test seam today.
//
// Task 2 will add a narrow, env-guarded provider-injection seam (per the
// plan's Chapter 1 discipline: "Only if no provider-injection seam exists,
// add a test-only hook guarded by `process.env.MMAGENT_TEST_PROVIDER_OVERRIDE === '1'`").
// Until Task 2 lands that seam, `boot()` throws a clear error — the fixture
// is compile-ready but not yet runtime-ready. Contract tests that depend on
// the harness must use `it.todo` / `it.skip` (per global convention #12)
// until Task 2 completes.

import type { Provider } from '@zhixuan92/multi-model-agent-core';
import { freezeClock } from './deterministic-clock.js';
import { guardNoNetwork } from './mock-providers.js';

export interface HarnessHandle {
  baseUrl: string;
  token: string;
  close(): Promise<void>;
}

export interface BootOptions {
  provider: Provider;
  cwd: string;
}

export async function boot(_opts: BootOptions): Promise<HarnessHandle> {
  guardNoNetwork();
  freezeClock();
  throw new Error(
    'contract-test harness boot() not yet wired: pending Task 2 provider-injection seam. ' +
      'Tests depending on this should use it.todo / it.skip until Task 2 lands.',
  );
}
