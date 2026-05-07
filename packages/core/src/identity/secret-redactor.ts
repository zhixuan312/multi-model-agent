const PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_\-]{20,}/g, '[REDACTED-API-KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED-AWS-KEY]'],
  [/Bearer\s+[A-Za-z0-9._\-]{20,}/g, 'Bearer [REDACTED]'],
];

const REDACTED_CYCLE = '[REDACTED-CYCLE]';

export function redactSecrets(value: unknown): unknown {
  const visited = new WeakSet<object>();
  return walk(value, visited);
}

function walk(value: unknown, visited: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const [rx, repl] of PATTERNS) out = out.replace(rx, repl);
    return out;
  }
  if (Array.isArray(value)) {
    if (visited.has(value)) return REDACTED_CYCLE;
    visited.add(value);
    return value.map(v => walk(v, visited));
  }
  if (value && typeof value === 'object') {
    if (visited.has(value)) return REDACTED_CYCLE;
    visited.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, visited);
    return out;
  }
  return value;
}
