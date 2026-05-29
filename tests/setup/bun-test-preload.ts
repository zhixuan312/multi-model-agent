// Bun test preload.
// (0) TELEMETRY GUARD — tests must NEVER upload to the real telemetry backend.
//     Many tests boot a server (contract harness startServer / CLI startServe).
//     startServer wires a TelemetryUploader from the module-level recorder
//     singleton; with the developer's real ~/.multi-model consent ON and the
//     default hosted endpoint, that ships MOCK dispatches ($0; model normalizes to
//     'custom') to prod events_raw. In a shared `bun test` process the recorder
//     singleton leaks across files, so one startServe test makes EVERY later
//     harness test upload. Force consent OFF + blank the endpoint here, before any
//     test loads, so no test path can upload regardless of ambient config. Tests
//     that exercise telemetry/consent set these explicitly per-test + restore.
process.env.MMAGENT_TELEMETRY = '0';
process.env.MMAGENT_TELEMETRY_ENDPOINT = '';

// (1) Expose bun:test as globals — replicates Vitest's `globals: true` so test
//     files that used describe/it/expect/vi/etc. without importing them keep working.
// (2) Bridge the few Vitest `vi.*` methods Bun's `vi` shim lacks.
import * as bunTest from 'bun:test';
import { vi, setSystemTime } from 'bun:test';

const g = globalThis as unknown as Record<string, unknown>;
for (const name of [
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach',
  'beforeAll', 'afterAll', 'mock', 'spyOn', 'vi', 'expectTypeOf', 'setSystemTime',
] as const) {
  if (g[name] === undefined && (bunTest as Record<string, unknown>)[name] !== undefined) {
    g[name] = (bunTest as Record<string, unknown>)[name];
  }
}

// Bun's `vi` exposes fn/mock/spyOn/useFakeTimers/advanceTimersByTime/useRealTimers/clearAllMocks,
// but not these three — patch the shared singleton so test files need no edits.
const v = vi as unknown as Record<string, unknown>;
if (typeof v.setSystemTime !== 'function') v.setSystemTime = (d?: number | Date) => setSystemTime(d as Date);
if (typeof v.mocked !== 'function') v.mocked = <T>(x: T): T => x; // type-only passthrough
if (typeof v.hoisted !== 'function') v.hoisted = <T>(factory: () => T): T => factory();

export {};
