export interface DraftIdComponents {
  requestId: string;
  taskIndex: number;
  nodeId: string;
}

export function escapeFanoutKey(key: string): string {
  return encodeURIComponent(key);
}

export function canonicalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function parseDraftId(draftId: string): DraftIdComponents | null {
  const parts = draftId.split(':');
  if (parts.length !== 3) return null;
  const [requestId, taskIndexStr, nodeId] = parts;
  const taskIndex = parseInt(taskIndexStr, 10);
  if (isNaN(taskIndex)) return null;
  return { requestId, taskIndex, nodeId };
}

export function createDraftId(requestId: string, taskIndex: number, nodeId = 'root'): string {
  return `${requestId}:${taskIndex}:${nodeId}`;
}

export function generateRequestId(): string {
  const { randomUUID } = require('node:crypto');
  return randomUUID();
}

export function disambiguateFanoutKeys(draftIds: string[]): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const id of draftIds) {
    const parsed = parseDraftId(id);
    if (!parsed) continue;
    const existing = seen.get(parsed.nodeId);
    if (existing) {
      existing.push(id);
    } else {
      seen.set(parsed.nodeId, [id]);
    }
  }
  const duplicates = new Map<string, string[]>();
  for (const [nodeId, ids] of seen) {
    if (ids.length > 1) {
      duplicates.set(nodeId, ids);
    }
  }
  return duplicates;
}