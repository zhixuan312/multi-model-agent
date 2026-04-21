import type { DiagnosticLogger } from '@zhixuan92/multi-model-agent-core';

/** No-op logger for tests that exercise tool-register helpers but don't care about diagnostic events. */
export function makeNoopLogger(): DiagnosticLogger {
  return {
    startup: () => {},
    requestStart: () => {},
    requestComplete: () => {},
    error: () => {},
    shutdown: () => {},
    expectedPath: () => undefined,
  };
}
