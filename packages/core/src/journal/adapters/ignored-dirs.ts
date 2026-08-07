/**
 * Directories never worth indexing as repository content: VCS metadata,
 * dependencies, build output.
 *
 * Shared between {@link FileCorpusAdapter}'s directory walk (`./file-adapter.ts`)
 * and the git fast path in `../engine/index-store.ts`'s `ensureFreshSymbols`, so
 * both apply exactly the same rule. The walk prunes these directories as it
 * descends (cheap: it never even opens them); the git fast path instead
 * receives a FLAT list of git-reported paths (from `git ls-files` / `git
 * status`) with no directory structure to prune, so it applies
 * {@link isUnderIgnoredDir} explicitly to every reported path instead. Kept in
 * its own zero-dependency module (rather than inside `file-adapter.ts`, which
 * already imports from `index-store.ts`) so `index-store.ts` can import it
 * back without creating an import cycle between the two files.
 */
export const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules', 'dist', 'build']);

/**
 * True when `relPath` (a corpus-relative, `/`-separated path) lies inside one
 * of {@link IGNORED_DIR_NAMES} — checked against every path segment except the
 * final filename.
 */
export function isUnderIgnoredDir(relPath: string): boolean {
  const segments = relPath.split('/');
  return segments.slice(0, -1).some((segment) => IGNORED_DIR_NAMES.has(segment));
}
