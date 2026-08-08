/**
 * Guidance injected into every worker whose task involves searching a codebase.
 *
 * Measured motivation: across 285 real tasks, 84% of all worker tool calls were
 * file search or file read, and the dominant pattern was repetition. The most
 * common consecutive pairs were search-then-search (1246) and read-then-read
 * (787). On the Codex side a single lookup routinely cost three commands: `rg`
 * to locate, `sed` to slice, `nl` to number.
 *
 * Every one of those is a turn, and every turn resends the whole transcript.
 * So the cost of a sprawling `rg` is paid once when it runs and again on every
 * later turn. `mma search` exists to collapse that loop: one call returns the
 * path, the line range, the enclosing symbol, and the numbered body.
 *
 * This is guidance, not a restriction. `rg`, `grep` and `Read` remain available
 * and are the right tool for a literal string, a non-code file, or reading a
 * region already known. The point is to stop paying three round trips for the
 * question `mma search` answers in one.
 */
export const CODE_SEARCH_BLOCK = `## Searching this codebase

Prefer \`mma search\` over a raw \`rg\`/\`grep\` sweep when you are looking for WHERE something lives. It returns ranked matches with the file path, the line range, the enclosing symbol name and kind, and the body already numbered — so you usually do not need a follow-up read.

    mma search "<what you are looking for>" [--limit N] [--lines N] [--json]

It searches an index of this repository that is kept current automatically. Results are ranked and capped, so the output stays small.

Use it INSTEAD OF the common three-step loop of searching, then slicing the file, then numbering the lines. One call replaces all three.

Keep using \`rg\`, \`grep\` and file reads when they are the better tool:
- an exact literal string, a regex, or a comment you must match verbatim
- non-code files the symbol index does not cover
- reading a specific region you have already located
- confirming something is ABSENT (a negative result)

Two habits matter more than which tool you pick. Do not re-run a search you have already run. And do not read a whole file when you already know the line range.`;
