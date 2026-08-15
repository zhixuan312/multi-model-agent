const PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_\-]{20,}/g, '[REDACTED-API-KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED-AWS-KEY]'],
  // GitHub tokens: classic PATs + OAuth/user/server/refresh (gh[porus]_) and
  // fine-grained PATs (github_pat_). Redacted before Bearer so a `Bearer ghp_…`
  // still collapses to a GitHub marker.
  [/\b(?:gh[oprsu]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, '[REDACTED-GITHUB-TOKEN]'],
  // GitLab tokens: glpat-, gldt-, glrt-, glcbt-, glptt-, glsoat-, … (gl + routing
  // prefix + `-` + ≥20 token chars). The config stores a GitLab-capable token surface.
  [/\bgl[a-z]{2,6}-[A-Za-z0-9_\-]{20,}/g, '[REDACTED-GITLAB-TOKEN]'],
  [/Bearer\s+[A-Za-z0-9._\-]{20,}/g, 'Bearer [REDACTED]'],
];

const REDACTED_CYCLE = '[REDACTED-CYCLE]';

export function redactSecrets(value: unknown): unknown {
  const visited = new WeakSet<object>();
  return walk(value, visited);
}

/**
 * `visited` holds the ANCESTORS of the current node, not every node ever seen.
 *
 * It used to be the latter — entries were added and never removed — which made it a
 * "seen anywhere" set rather than a cycle detector. Any value referenced twice in the same
 * structure, with no cycle involved at all, came out as `[REDACTED-CYCLE]` the second time.
 *
 * That is not hypothetical: `buildEnvelopeSnapshot` assigns
 * `realFilesChanged: result.filesChangedFromGit ?? implTurn.filesWritten`, so on every read route
 * — and every write route where git had no answer — `filesWritten` and `realFilesChanged` are the
 * SAME array instance. Every such envelope reached the diagnostics JSONL with
 * `"realFilesChanged": "[REDACTED-CYCLE]"` in place of its file list, and an operator reading the
 * log for a forensic answer found a redaction marker over data that was never sensitive and never
 * circular.
 *
 * Deleting on the way out is what makes it path-based: a node is only a cycle if it is its own
 * ancestor.
 */
function walk(value: unknown, visited: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const [rx, repl] of PATTERNS) out = out.replace(rx, repl);
    return out;
  }
  if (Array.isArray(value)) {
    if (visited.has(value)) return REDACTED_CYCLE;
    visited.add(value);
    const out = value.map(v => walk(v, visited));
    visited.delete(value);
    return out;
  }
  if (value && typeof value === 'object') {
    if (visited.has(value)) return REDACTED_CYCLE;
    visited.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, visited);
    visited.delete(value);
    return out;
  }
  return value;
}
