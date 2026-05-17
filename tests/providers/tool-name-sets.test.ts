import { describe, it, expect } from 'vitest';
import {
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  SHELL_TOOL_NAMES,
} from '../../packages/core/src/providers/tool-name-sets.js';

/**
 * Gap 14 (4.0.3+): runner-shell + running-headline-sink shared a tool-name
 * categorization but kept independent copies that drifted. Pre-fix the
 * sink's WRITE_TOOLS was {writeFile, write_file} while the runner had
 * {writeFile, write_file, editFile, edit_file} — so a worker calling
 * edit_file was tracked in runResult.filesWritten but the polling
 * headline reported "0 write" for the entire run.
 *
 * The fix is structural (single export from one module). These tests
 * lock the contract so future contributors can't reintroduce drift.
 */
describe('tool-name-sets contract (Gap 14)', () => {
  it('WRITE_TOOL_NAMES includes edit_file + editFile (regression: was missing in sink)', () => {
    expect(WRITE_TOOL_NAMES.has('edit_file')).toBe(true);
    expect(WRITE_TOOL_NAMES.has('editFile')).toBe(true);
    expect(WRITE_TOOL_NAMES.has('write_file')).toBe(true);
    expect(WRITE_TOOL_NAMES.has('writeFile')).toBe(true);
  });

  it('READ_TOOL_NAMES covers read + search', () => {
    expect(READ_TOOL_NAMES.has('read_file')).toBe(true);
    expect(READ_TOOL_NAMES.has('readFile')).toBe(true);
    expect(READ_TOOL_NAMES.has('grep')).toBe(true);
    expect(READ_TOOL_NAMES.has('glob')).toBe(true);
    expect(READ_TOOL_NAMES.has('list_files')).toBe(true);
    expect(READ_TOOL_NAMES.has('listFiles')).toBe(true);
  });

  it('SHELL_TOOL_NAMES covers shell variants', () => {
    expect(SHELL_TOOL_NAMES.has('run_shell')).toBe(true);
    expect(SHELL_TOOL_NAMES.has('runShell')).toBe(true);
    expect(SHELL_TOOL_NAMES.has('shell')).toBe(true);
    expect(SHELL_TOOL_NAMES.has('bash')).toBe(true);
  });

  it('the three sets are disjoint (a tool name is exactly one category)', () => {
    for (const name of WRITE_TOOL_NAMES) {
      expect(READ_TOOL_NAMES.has(name)).toBe(false);
      expect(SHELL_TOOL_NAMES.has(name)).toBe(false);
    }
    for (const name of READ_TOOL_NAMES) {
      expect(SHELL_TOOL_NAMES.has(name)).toBe(false);
    }
  });
});
