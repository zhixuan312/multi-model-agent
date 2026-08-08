/**
 * Where a repository's derived code index lives, and how a free-text question
 * becomes the tokens that search it.
 *
 * Both the `investigate` preprocessor and the `mma search` CLI must resolve the
 * SAME database file and tokenize a question the SAME way. If they diverged,
 * each would silently build and query its own index of the same repository —
 * doubling the build cost and making the CLI's answers differ from the ones a
 * worker is given. That is why this lives in one module rather than being
 * duplicated at each call site.
 */
import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expandHome } from '../expand-home.js';

/**
 * Absolute path of the corpus index for `cwd`, under MMA's own state directory.
 *
 * The index is a derived cache, so it deliberately does NOT live inside the
 * repository being indexed — pointing a read route at someone else's checkout
 * must leave that checkout untouched.
 *
 * The key is a hash of the REAL path, so a symlinked, relative, or
 * trailing-slash spelling of one repository all share a single index. The
 * readable basename prefix is for human debugging only and never affects
 * identity. Creates the containing directory if it does not exist.
 */
export async function corpusIndexDbPath(cwd: string, stateDir: string): Promise<string> {
  const realRoot = await realpath(cwd);
  const hash = createHash('sha256').update(realRoot).digest('hex').slice(0, 16);
  const dir = join(expandHome(stateDir), 'corpus-index');
  await mkdir(dir, { recursive: true });
  return join(dir, `${basename(realRoot)}-${hash}.db`);
}

/**
 * Free text to the distinct lowercase tokens used for symbol search.
 *
 * Single characters are dropped: they carry almost no selectivity and, being
 * under the trigram minimum, would force the slower `LIKE` path.
 */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return Array.from(new Set(matches.filter((token) => token.length > 1)));
}
