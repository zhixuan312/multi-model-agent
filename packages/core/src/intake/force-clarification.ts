type ForcedClarificationMap = Map<string /* batchId */, string /* reason */>;
const _forcedClarifications: ForcedClarificationMap = new Map();
const _globalForced: { reason: string | null } = { reason: null };

function isSeamEnabled(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.MMAGENT_TEST_SEAMS === '1';
}

export function __forceClarification(reason: string, batchId?: string): string {
  if (!isSeamEnabled()) return '';
  const id = batchId ?? `forced-${Date.now()}-${Math.random()}`;
  _forcedClarifications.set(id, reason);
  return id;
}

export function __forceClarificationGlobal(reason: string): void {
  if (!isSeamEnabled()) return;
  _globalForced.reason = reason;
}

export function __clearForcedClarification(batchId?: string): void {
  if (batchId) _forcedClarifications.delete(batchId);
  else { _forcedClarifications.clear(); _globalForced.reason = null; }
}

export function __consumeForcedClarification(batchId: string): string | null {
  if (!isSeamEnabled()) return null;
  if (_forcedClarifications.has(batchId)) {
    const reason = _forcedClarifications.get(batchId)!;
    _forcedClarifications.delete(batchId);
    return reason;
  }
  if (_globalForced.reason !== null) {
    const reason = _globalForced.reason;
    _globalForced.reason = null;
    return reason;
  }
  const envReason = process.env.MMAGENT_FORCED_CLARIFICATION;
  if (envReason) return envReason;
  return null;
}
