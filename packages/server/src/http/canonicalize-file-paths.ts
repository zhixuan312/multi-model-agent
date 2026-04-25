import { realpathSync, existsSync } from 'node:fs';
import * as path from 'node:path';

export type CanonicalizeResult =
  | string[]
  | { error: 'invalid_request'; fieldErrors: { filePaths: string[] } };

export function canonicalizeFilePaths(rawPaths: string[], cwd: string): CanonicalizeResult {
  const realCwd = realpathSync(cwd);
  const accepted: string[] = [];
  const offenders: string[] = [];

  for (const raw of rawPaths) {
    const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(realCwd, raw);
    let cursor = resolved;
    while (!existsSync(cursor) && path.dirname(cursor) !== cursor) {
      cursor = path.dirname(cursor);
    }
    let realAncestor: string;
    try {
      realAncestor = realpathSync(cursor);
    } catch {
      offenders.push(raw);
      continue;
    }
    const suffix = path.relative(cursor, resolved);
    const candidate = suffix ? path.normalize(path.join(realAncestor, suffix)) : realAncestor;
    const rel = path.relative(realCwd, candidate);
    const inside = rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
    if (!inside) {
      offenders.push(raw);
      continue;
    }
    accepted.push(candidate);
  }

  if (offenders.length > 0) {
    return { error: 'invalid_request', fieldErrors: { filePaths: offenders } };
  }
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const p of accepted) if (!seen.has(p)) { seen.add(p); dedup.push(p); }
  return dedup;
}
