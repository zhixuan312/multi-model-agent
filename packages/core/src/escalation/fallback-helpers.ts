import type { Provider, AgentType, RunResult } from '../types.js';

/** Two providers are "identical" iff they resolve to the same effective backend
 *  (type + model + baseUrl + apiKey wiring). When an operator points both tiers
 *  at the same backend (one-provider deployment), cross-tier fallback is
 *  structurally pointless — alt would just hit the same place. Comparing the
 *  serialized config catches this without a new operator-facing flag. */
export function providersIdentical(a: Provider, b: Provider): boolean {
  return JSON.stringify(a.config) === JSON.stringify(b.config);
}

/** Lifecycle helper: builds the synthetic RunResult expected when both tiers are
 *  unavailable. Status is the new 'unavailable' value (NOT 'api_error') so
 *  re-passing the synthetic into runWithFallback's isTransportFailure cannot
 *  retrigger fallback.
 *
 *  IMPORTANT: This shape MUST satisfy `RunResult` (see types.ts). Confirmed
 *  required fields: output, status, usage, turns, filesRead, filesWritten,
 *  toolCalls, outputIsDiagnostic, escalationLog. All other RunResult fields
 *  are optional. */
export function makeSyntheticRunResult(assigned: AgentType, errorCode: string): RunResult {
  return {
    status: 'unavailable',
    output: '',
    outputIsDiagnostic: true,
    error: `runWithFallback: both tiers unavailable (assigned=${assigned})`,
    errorCode,
    retryable: false,
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    escalationLog: [],
    actualCostUSD: 0,
    directoriesListed: [],
  };
}

export function isReviewTransportFailure(
  r: { status?: string },
): boolean {
  return r.status === 'api_error' || r.status === 'provider_transport_failure' || r.status === 'timeout';
}

export function scoreWork<T>(r: T | undefined): number {
  if (!r) return 0;
  const usage = (r as { usage?: { inputTokens?: number } }).usage ?? {};
  const turns = (r as { turns?: number }).turns ?? 0;
  const filesWritten = ((r as { filesWritten?: unknown[] }).filesWritten ?? []).length ?? 0;
  return turns + filesWritten + (usage.inputTokens ?? 0) / 1000;
}
