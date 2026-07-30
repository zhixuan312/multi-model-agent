import { atomicWriteClaudeDesktopConfig } from '../../packages/server/src/skill-install/claude-desktop-file.js';

describe('Claude Desktop atomic config write seam', () => {
  it('backs up the original bytes only for the first of two sequential changes', async () => {
    let config = Buffer.from('{"before":1}\n');
    let backup: Buffer | undefined;
    const temp = new Map<string, Buffer>();
    const deps = {
      findExistingDesktopBackup: () => (backup ? '/cfg.json.bak.20260730120000' : undefined),
      createTemp: () => '/dir/.cfg.tmp',
      write: (p: string, bytes: Buffer) => { temp.set(p, bytes); },
      fsync: () => undefined,
      writeBackup: (_p: string, bytes: Buffer) => { backup = Buffer.from(bytes); },
      rename: (from: string) => { config = temp.get(from)!; },
      remove: (p: string) => { temp.delete(p); },
      now: () => new Date('2026-07-30T12:00:00'),
    };
    await atomicWriteClaudeDesktopConfig(
      { configPath: '/dir/cfg.json', originalBytes: config, nextBytes: Buffer.from('{"install":true}\n') },
      deps,
    );
    await atomicWriteClaudeDesktopConfig(
      { configPath: '/dir/cfg.json', originalBytes: config, nextBytes: Buffer.from('{"uninstall":true}\n') },
      deps,
    );
    expect(config.toString()).toBe('{"uninstall":true}\n');
    // The backup holds the ORIGINAL bytes, not the state one write ago.
    expect(backup?.toString()).toBe('{"before":1}\n');
  });

  it.each(['writeBackup', 'fsync', 'rename'] as const)(
    'leaves bytes unchanged and removes its temp when %s fails',
    async (failure) => {
      const original = Buffer.from('original');
      const config = Buffer.from(original);
      const temp = new Set<string>();
      const deps = {
        findExistingDesktopBackup: () => undefined,
        createTemp: () => { temp.add('/dir/.tmp'); return '/dir/.tmp'; },
        write: () => undefined,
        writeBackup: (): void => undefined,
        fsync: (p: string) => { if (failure === 'fsync' && p === '/dir/.tmp') throw new Error('disk full'); },
        rename: () => { if (failure === 'rename') throw new Error('rename failed'); },
        remove: (p: string) => { temp.delete(p); },
        now: () => new Date(),
      };
      if (failure === 'writeBackup') deps.writeBackup = () => { throw new Error('backup failed'); };
      await expect(atomicWriteClaudeDesktopConfig(
        { configPath: '/dir/cfg.json', originalBytes: original, nextBytes: Buffer.from('next') },
        deps,
      )).rejects.toThrow();
      expect(config).toEqual(original);
      expect(temp).toEqual(new Set());
    },
  );
});
