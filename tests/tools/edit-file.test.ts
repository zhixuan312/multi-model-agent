import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createToolImplementations, MAX_WRITE_FILE_BYTES } from '../../packages/core/src/tools/definitions.js';
import { FileTracker } from '../../packages/core/src/tools/tracker.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('editFile', () => {
  let tmpDir: string;
  let tracker: FileTracker;
  let tools: ReturnType<typeof createToolImplementations>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-edit-'));
    tracker = new FileTracker();
    tools = createToolImplementations(tracker, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces a unique match correctly', async () => {
    const filePath = path.join(tmpDir, 'sample.txt');
    fs.writeFileSync(filePath, 'hello world\nfoo bar\nbaz qux\n');
    await tools.editFile(filePath, 'foo bar', 'foo BAZ');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world\nfoo BAZ\nbaz qux\n');
  });

  it('throws when oldContent is not found', async () => {
    const filePath = path.join(tmpDir, 'missing.txt');
    fs.writeFileSync(filePath, 'no match here\n');
    await expect(tools.editFile(filePath, 'not present', 'replacement')).rejects.toThrow(
      /oldContent not found in file/,
    );
  });

  it('throws when oldContent matches multiple non-overlapping locations', async () => {
    const filePath = path.join(tmpDir, 'multi.txt');
    fs.writeFileSync(filePath, 'foo\nfoo\n');
    await expect(tools.editFile(filePath, 'foo', 'bar')).rejects.toThrow(
      /oldContent matches multiple locations/,
    );
  });

  it('allows overlapping matches (search from firstIndex + oldContent.length)', async () => {
    // Pattern "aba" overlaps with itself at position 1 within "ababab"
    const filePath = path.join(tmpDir, 'overlap.txt');
    fs.writeFileSync(filePath, 'ababab');
    // Should find only one match at position 0 and replace it
    await tools.editFile(filePath, 'ababab', 'XY');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('XY');
  });

  it('tracks the edit as a write in FileTracker', async () => {
    const filePath = path.join(tmpDir, 'tracked.txt');
    fs.writeFileSync(filePath, 'original');
    await tools.editFile(filePath, 'original', 'edited');
    expect(tracker.getWrites()).toContain(filePath);
  });

  it('tracks tool call in FileTracker', async () => {
    const filePath = path.join(tmpDir, 'logged.txt');
    fs.writeFileSync(filePath, 'content');
    await tools.editFile(filePath, 'cont', 'CHANGED');
    const calls = tracker.getToolCalls();
    expect(calls.some(c => c.startsWith('editFile('))).toBe(true);
  });

  it('rejects path traversal under cwd-only sandbox', async () => {
    await expect(tools.editFile('/etc/passwd', 'root', 'evil')).rejects.toThrow(
      /Path traversal denied/,
    );
  });

  it('rejects path traversal via ../', async () => {
    await expect(tools.editFile('../../../etc/passwd', 'root', 'evil')).rejects.toThrow(
      /Path traversal denied/,
    );
  });

  it('works on a large file (>500 lines)', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push(`Line ${i}: some content here`);
    }
    const filePath = path.join(tmpDir, 'large.txt');
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const target = 'Line 300: some content here';
    await tools.editFile(filePath, target, 'Line 300: MODIFIED content');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('Line 300: MODIFIED content');
    expect(content).not.toContain('Line 300: some content here');
  });

  it('replaces only the first occurrence when multiple non-overlapping matches exist', async () => {
    const filePath = path.join(tmpDir, 'partial.txt');
    fs.writeFileSync(filePath, 'AAA\nBBB\nAAA\nCCC\n');
    // Must throw because "AAA" appears twice non-overlapping
    await expect(tools.editFile(filePath, 'AAA', 'XXX')).rejects.toThrow(
      /oldContent matches multiple locations/,
    );
  });

  it('allows adjacent matches (oldContent ends where next begins)', async () => {
    const filePath = path.join(tmpDir, 'adjacent.txt');
    fs.writeFileSync(filePath, 'ab ab');
    // "ab" appears at position 0 and 3 (non-adjacent: gap between)
    await expect(tools.editFile(filePath, 'ab', 'x')).rejects.toThrow(
      /oldContent matches multiple locations/,
    );
  });

  it('replaces at beginning of file', async () => {
    const filePath = path.join(tmpDir, 'begin.txt');
    fs.writeFileSync(filePath, 'START\nrest of file');
    await tools.editFile(filePath, 'START', 'BEGIN');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('BEGIN\nrest of file');
  });

  it('replaces at end of file', async () => {
    const filePath = path.join(tmpDir, 'end.txt');
    fs.writeFileSync(filePath, 'start\nEND');
    await tools.editFile(filePath, 'END', 'FINISH');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('start\nFINISH');
  });

  it('handles empty newContent (deletion)', async () => {
    const filePath = path.join(tmpDir, 'delete.txt');
    fs.writeFileSync(filePath, 'hello world');
    await tools.editFile(filePath, ' world', '');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello');
  });

  it('handles empty oldContent (insertion)', async () => {
    const filePath = path.join(tmpDir, 'insert.txt');
    fs.writeFileSync(filePath, 'helloworld');
    // Insert at beginning
    await tools.editFile(filePath, 'hello', 'hello world: ');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world: world');
  });

  it('throws when edited content exceeds MAX_WRITE_FILE_BYTES', async () => {
    const filePath = path.join(tmpDir, 'oversized.txt');
    fs.writeFileSync(filePath, 'x');
    const oversized = 'y'.repeat(MAX_WRITE_FILE_BYTES + 1);
    await expect(tools.editFile(filePath, 'x', oversized)).rejects.toThrow(
      /Edited content too large/,
    );
  });

  it('editFile rejects symlink pointing outside cwd', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-edit-outside-'));
    try {
      fs.writeFileSync(path.join(outsideDir, 'target.txt'), 'original');
      fs.symlinkSync(path.join(outsideDir, 'target.txt'), path.join(tmpDir, 'link.txt'));
      await expect(tools.editFile('link.txt', 'original', 'modified')).rejects.toThrow(
        /Path traversal denied/,
      );
      expect(fs.readFileSync(path.join(outsideDir, 'target.txt'), 'utf-8')).toBe('original');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
