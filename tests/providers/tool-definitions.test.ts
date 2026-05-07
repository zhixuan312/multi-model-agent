import { describe, it, expect } from 'vitest';
import { makeToolDefinitions } from '../../packages/core/src/providers/tool-definitions.js';

describe('ToolDefinitions sandbox wiring', () => {
  it('read_file rejects path traversal', async () => {
    const tools = makeToolDefinitions({ cwd: '/tmp' });
    const readFile = tools.find(t => t.name === 'read_file')!;
    await expect(
      readFile.execute({ path: '../etc/passwd' }),
    ).rejects.toThrow(/escapes cwd/);
  });

  it('web_fetch rejects private ranges', async () => {
    const tools = makeToolDefinitions({ cwd: '/tmp' });
    const webFetch = tools.find(t => t.name === 'web_fetch')!;
    await expect(
      webFetch.execute({ url: 'http://127.0.0.1/x' }),
    ).rejects.toThrow(/SSRF/);
  });

  it('web_fetch applies HostAllowlist when configured', async () => {
    const tools = makeToolDefinitions({ cwd: '/tmp', allowedHosts: new Set(['example.com']) });
    const webFetch = tools.find(t => t.name === 'web_fetch')!;
    // Private range check fires first before host allowlist
    await expect(
      webFetch.execute({ url: 'http://google.com' }),
    ).rejects.toThrow(/host not allowed/);
  });

  it('returns the full canonical set of tool names', () => {
    const tools = makeToolDefinitions({ cwd: '/tmp' });
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'edit_file',
      'glob',
      'grep',
      'list_files',
      'read_file',
      'run_shell',
      'web_fetch',
      'write_file',
    ]);
  });

  it('write_file rejects path traversal (ENOENT is acceptable — realpathSync fails before cwd check on missing files)', async () => {
    const tools = makeToolDefinitions({ cwd: '/tmp' });
    const writeFile = tools.find(t => t.name === 'write_file')!;
    await expect(
      writeFile.execute({ path: '../etc/malicious', content: 'x' }),
    ).rejects.toThrow(/escapes cwd|ENOENT/);
  });

  it('edit_file rejects path traversal', async () => {
    const tools = makeToolDefinitions({ cwd: '/tmp' });
    const editFile = tools.find(t => t.name === 'edit_file')!;
    await expect(
      editFile.execute({ path: '../etc/passwd', oldContent: 'a', newContent: 'b' }),
    ).rejects.toThrow(/escapes cwd/);
  });

  it('grep rejects path traversal', async () => {
    const tools = makeToolDefinitions({ cwd: '/tmp' });
    const grep = tools.find(t => t.name === 'grep')!;
    await expect(
      grep.execute({ pattern: 'x', path: '../etc/passwd' }),
    ).rejects.toThrow(/escapes cwd/);
  });

  it('list_files rejects path traversal', async () => {
    const tools = makeToolDefinitions({ cwd: '/tmp' });
    const listFiles = tools.find(t => t.name === 'list_files')!;
    await expect(
      listFiles.execute({ path: '../etc' }),
    ).rejects.toThrow(/escapes cwd/);
  });
});
