// Bun test preload — bridges the few Vitest `vi.*` methods Bun's `vi` shim lacks.
import { vi, setSystemTime } from 'bun:test';

// Bun's `vi` exposes fn/mock/spyOn/useFakeTimers/advanceTimersByTime/useRealTimers/clearAllMocks,
// but not these three — patch the shared singleton so test files need no edits beyond the import source.
const v = vi as unknown as Record<string, unknown>;
if (typeof v.setSystemTime !== 'function') v.setSystemTime = (d?: number | Date) => setSystemTime(d as Date);
if (typeof v.mocked !== 'function') v.mocked = <T>(x: T): T => x; // type-only passthrough
if (typeof v.hoisted !== 'function') v.hoisted = <T>(factory: () => T): T => factory();

export {};
