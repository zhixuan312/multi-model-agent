/**
 * Two habits, injected into every worker prompt, that keep a task from paying
 * for the same information twice.
 *
 * Measured motivation: across 285 real tasks, 84% of all worker tool calls were
 * file search or file read, and the dominant pattern was repetition. The most
 * common consecutive pairs were search-then-search (1246) and read-then-read
 * (787). Every one of those is a turn, and every turn resends the whole
 * transcript, so a wasted lookup is paid once when it runs and again on every
 * later turn.
 *
 * This is what survives of the deleted `CODE_SEARCH_BLOCK`. That block existed
 * to steer workers toward the `mma search` command, which is gone along with the
 * code index it queried. These two rules were never about that command: they are
 * tool-neutral, and the measurement that motivated them is unaffected by the
 * removal.
 *
 * Injected for EVERY task type rather than for a `searchesCode` subset. The old
 * flag existed because `mma search` was only meaningful against a code corpus.
 * Not repeating a lookup applies to a journal query and a web search just as
 * much as to a `grep`, so a per-type flag would only be a way to get it wrong.
 */
export const SEARCH_HYGIENE_BLOCK = `## Do not pay twice for the same information

Two habits matter more than which tool you pick:

- Do not re-run a search you have already run. If you need the earlier result again, use what it already told you.
- Do not read a whole file when you already know the line range. Read the range.

Each repeated lookup costs a turn, and every turn resends the whole conversation so far. The cost is paid again on every later turn, not once.`;
