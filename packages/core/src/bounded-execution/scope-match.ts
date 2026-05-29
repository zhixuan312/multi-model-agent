import { resolve } from 'node:path';

export interface NormalizedScopeEntry {
  absPath: string;    // absolute, .. resolved
  kind: 'directory' | 'file';
}

export function normalizeScopeEntry(cwd: string, entry: string): NormalizedScopeEntry {
  const absPath = resolve(cwd, entry);
  if (entry.endsWith('/')) return { absPath, kind: 'directory' };
  // No-extension entries (no '.' after the last '/') → inferred directory
  const lastSlash = absPath.lastIndexOf('/');
  const basename = absPath.slice(lastSlash + 1);
  if (!basename.includes('.')) return { absPath, kind: 'directory' };
  return { absPath, kind: 'file' };
}

export function isInScope(filePath: string, scope: NormalizedScopeEntry[]): boolean {
  for (const entry of scope) {
    if (entry.kind === 'file') {
      if (filePath === entry.absPath) return true;
    } else {
      // directory: prefix match with a trailing slash so 'src/auth' doesn't match 'src/authenticate'
      const prefix = entry.absPath.endsWith('/') ? entry.absPath : `${entry.absPath}/`;
      if (filePath.startsWith(prefix)) return true;
    }
  }
  return false;
}