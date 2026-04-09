import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createToolImplementations } from '../../src/tools/definitions.js';
import { FileTracker } from '../../src/tools/tracker.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('tool definitions', () => {
  let tmpDir: string;
  let tracker: FileTracker;
  let tools: ReturnType<typeof createToolImplementations>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-tools-'));
    tracker = new FileTracker();
    tools = createToolImplementations(tracker, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('readFile reads a file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'world');
    const result = await tools.readFile(path.join(tmpDir, 'hello.txt'));
    expect(result).toBe('world');
  });

  it('writeFile creates a file and tracks it', async () => {
    const filePath = path.join(tmpDir, 'new.txt');
    await tools.writeFile(filePath, 'content');

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('content');
    expect(tracker.getFiles()).toContain(filePath);
  });

  it('writeFile creates parent directories', async () => {
    const filePath = path.join(tmpDir, 'sub', 'dir', 'file.txt');
    await tools.writeFile(filePath, 'deep');

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('deep');
  });

  it('runShell executes a command (policy: none)', async () => {
    const unconfined = createToolImplementations(new FileTracker(), tmpDir, 'none');
    const result = await unconfined.runShell('echo hello');
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('runShell captures stderr and exit code on failure (policy: none)', async () => {
    const unconfined = createToolImplementations(new FileTracker(), tmpDir, 'none');
    const result = await unconfined.runShell('ls /nonexistent-dir-xyz 2>&1; exit 1');
    expect(result.exitCode).toBe(1);
  });

  it('glob finds files by pattern', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'c.js'), '');

    const result = await tools.glob('*.ts');
    expect(result).toHaveLength(2);
    expect(result.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('grep finds matching lines', async () => {
    fs.writeFileSync(path.join(tmpDir, 'code.ts'), 'line1\nfoo bar\nline3\nfoo baz\n');

    const result = await tools.grep('foo', path.join(tmpDir, 'code.ts'));
    expect(result).toContain('foo bar');
    expect(result).toContain('foo baz');
  });

  it('listFiles returns directory entries', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), '');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));

    const result = await tools.listFiles(tmpDir);
    expect(result).toContain('a.txt');
    expect(result).toContain('subdir/');
  });

  describe('path traversal prevention (sandboxPolicy: cwd-only)', () => {
    it('readFile rejects absolute path outside cwd', async () => {
      await expect(tools.readFile('/etc/passwd')).rejects.toThrow(/Path traversal denied/);
    });

    it('readFile rejects ../ traversal', async () => {
      await expect(tools.readFile('../../../etc/passwd')).rejects.toThrow(/Path traversal denied/);
    });

    it('writeFile rejects path outside cwd', async () => {
      await expect(tools.writeFile('/tmp/evil.txt', 'data')).rejects.toThrow(/Path traversal denied/);
    });

    it('grep rejects path outside cwd', async () => {
      await expect(tools.grep('root', '/etc/passwd')).rejects.toThrow(/Path traversal denied/);
    });

    it('listFiles rejects path outside cwd', async () => {
      await expect(tools.listFiles('/etc')).rejects.toThrow(/Path traversal denied/);
    });

    it('allows paths within cwd', async () => {
      fs.mkdirSync(path.join(tmpDir, 'sub'));
      fs.writeFileSync(path.join(tmpDir, 'sub', 'ok.txt'), 'fine');
      const result = await tools.readFile(path.join(tmpDir, 'sub', 'ok.txt'));
      expect(result).toBe('fine');
    });

    it('readFile rejects symlink pointing outside cwd', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-outside-'));
      try {
        fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'leaked');
        fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(tmpDir, 'link.txt'));
        await expect(tools.readFile('link.txt')).rejects.toThrow(/Path traversal denied/);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('writeFile rejects symlink pointing outside cwd', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-outside-'));
      try {
        fs.writeFileSync(path.join(outsideDir, 'target.txt'), 'original');
        fs.symlinkSync(path.join(outsideDir, 'target.txt'), path.join(tmpDir, 'link.txt'));
        await expect(tools.writeFile('link.txt', 'overwritten')).rejects.toThrow(/Path traversal denied/);
        expect(fs.readFileSync(path.join(outsideDir, 'target.txt'), 'utf-8')).toBe('original');
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('listFiles rejects symlinked directory pointing outside cwd', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-outside-'));
      try {
        fs.writeFileSync(path.join(outsideDir, 'file.txt'), '');
        fs.symlinkSync(outsideDir, path.join(tmpDir, 'outlink'));
        await expect(tools.listFiles('outlink')).rejects.toThrow(/Path traversal denied/);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('glob filters out results outside cwd via ../', async () => {
      // Create a file outside cwd to ensure it's not leaked
      const outsideDir = path.dirname(tmpDir);
      const outsideFile = path.join(outsideDir, 'mma-glob-test-outside.txt');
      fs.writeFileSync(outsideFile, '');
      try {
        const result = await tools.glob('../mma-glob-test-outside.txt');
        expect(result).toEqual([]);
      } finally {
        fs.unlinkSync(outsideFile);
      }
    });

    it('glob filters out symlinks pointing outside cwd', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-outside-'));
      try {
        fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'data');
        fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(tmpDir, 'linked.txt'));
        fs.writeFileSync(path.join(tmpDir, 'real.txt'), 'data');
        const result = await tools.glob('*.txt');
        expect(result).toContain('real.txt');
        expect(result).not.toContain('linked.txt');
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('runShell sandboxing', () => {
    it('runShell is blocked under cwd-only policy', async () => {
      await expect(tools.runShell('echo hello')).rejects.toThrow(/runShell is disabled under sandboxPolicy "cwd-only"/);
    });

    it('runShell is allowed under policy none', async () => {
      const unconfined = createToolImplementations(new FileTracker(), tmpDir, 'none');
      const result = await unconfined.runShell('echo hello');
      expect(result.stdout.trim()).toBe('hello');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('grep edge cases', () => {
    it('handles patterns starting with -', async () => {
      fs.writeFileSync(path.join(tmpDir, 'data.txt'), 'hello\n-foo bar\nworld\n');
      const result = await tools.grep('-foo', path.join(tmpDir, 'data.txt'));
      expect(result).toContain('-foo bar');
    });

    it('returns empty string when no matches found', async () => {
      fs.writeFileSync(path.join(tmpDir, 'data.txt'), 'hello\nworld\n');
      const result = await tools.grep('zzz_no_match', path.join(tmpDir, 'data.txt'));
      expect(result).toBe('');
    });

    it('throws on invalid regex pattern', async () => {
      fs.writeFileSync(path.join(tmpDir, 'data.txt'), 'hello\n');
      await expect(tools.grep('[', path.join(tmpDir, 'data.txt'))).rejects.toThrow();
    });

    it('throws on nonexistent file', async () => {
      await expect(tools.grep('hello', path.join(tmpDir, 'no-such-file.txt'))).rejects.toThrow();
    });
  });

  describe('abort signal', () => {
    it('grep rejects with AbortError when signal is already aborted', async () => {
      fs.writeFileSync(path.join(tmpDir, 'data.txt'), 'hello\nworld\n');
      const ac = new AbortController();
      ac.abort();
      const abortTools = createToolImplementations(new FileTracker(), tmpDir, 'cwd-only', ac.signal);
      await expect(abortTools.grep('hello', path.join(tmpDir, 'data.txt'))).rejects.toThrow(/abort/i);
    });
  });

  describe('sandboxPolicy: none allows any path', () => {
    it('readFile allows absolute paths outside cwd', async () => {
      const unconfined = createToolImplementations(new FileTracker(), tmpDir, 'none');
      // Just verify it doesn't throw traversal error (will throw ENOENT for nonexistent files)
      await expect(unconfined.readFile('/nonexistent-test-file-xyz')).rejects.not.toThrow(/Path traversal denied/);
    });
  });
});
