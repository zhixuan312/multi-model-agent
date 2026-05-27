// Bun test preload.
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
