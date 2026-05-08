/**
 * Single source of truth for tool-name → category sets.
 *
 * Two consumers historically maintained their own copies and drifted:
 *   - `runner-shell.ts` tracks `filesRead` / `filesWritten` arrays based
 *     on tool name → these flow into wire telemetry's
 *     `filesReadCount` / `filesWrittenCount`.
 *   - `running-headline-sink.ts` increments the polling headline's
 *     `read` / `write` counts from per-turn `toolCalls` records.
 *
 * Pre-4.0.3 the sink had `WRITE_TOOLS = {writeFile, write_file}` while
 * the runner had `WRITE_TOOL_NAMES = {writeFile, write_file, editFile,
 * edit_file}`. A worker calling `edit_file` correctly bumped the
 * runner's counter (so `filesWrittenCount` was right on the wire) but
 * the polling headline reported "0 write" — drift. This module
 * eliminates that risk: both consumers import from here.
 */

/** File-reading tools. Includes search/grep tools because they READ
 *  file content even though they don't return whole files — the wire
 *  attribution treats them uniformly as "read activity". */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  'readFile', 'read_file',
  'grep',
  'glob',
  'listFiles', 'list_files',
]);

/** File-writing tools. Both `writeFile` (full overwrite) and
 *  `editFile` (patch) modify the filesystem and count as writes. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'writeFile', 'write_file',
  'editFile', 'edit_file',
]);

/** Shell tools. Uncategorized for read/write attribution by name —
 *  the runner-shell inspects the command argument via
 *  `shellCommandWritesFs` (Gap 11) to attribute writes heuristically. */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'runShell', 'run_shell',
  'shell',
  'bash',
]);
