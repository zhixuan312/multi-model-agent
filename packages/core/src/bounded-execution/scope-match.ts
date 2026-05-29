import { resolve, sep } from 'node:path';

export interface NormalizedScopeEntry {
  absPath: string;    // absolute, .. resolved
  kind: 'directory' | 'file';
}

export function normalizeScopeEntry(cwd: string, entry: string): NormalizedScopeEntry {
  const absPath = resolve(cwd, entry);
  // The raw entry is forward-slash (plan/user convention); absPath is OS-native
  // (backslashes on Windows), so classify using the platform separator.
  if (entry.endsWith('/')) return { absPath, kind: 'directory' };
  // No-extension entries (no '.' after the last separator) → inferred directory
  const lastSep = absPath.lastIndexOf(sep);
  const basename = absPath.slice(lastSep + 1);
  if (!basename.includes('.')) return { absPath, kind: 'directory' };
  return { absPath, kind: 'file' };
}

export function isInScope(filePath: string, scope: NormalizedScopeEntry[]): boolean {
  for (const entry of scope) {
    if (entry.kind === 'file') {
      if (filePath === entry.absPath) return true;
    } else {
      // directory: prefix match with a trailing separator so 'src/auth' doesn't
      // match 'src/authenticate'. Use the platform sep (absPath is OS-native).
      const prefix = entry.absPath.endsWith(sep) ? entry.absPath : `${entry.absPath}${sep}`;
      if (filePath.startsWith(prefix)) return true;
    }
  }
  return false;
}