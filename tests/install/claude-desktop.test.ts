import { detectClaudeDesktop, installClaudeDesktop, uninstallClaudeDesktop, resolveClaudeDesktopConfigPath } from '../../packages/server/src/skill-install/skill-installers/claude-desktop.js';
// Imported REAL, not mocked — see the end-to-end test below.
import { atomicWriteClaudeDesktopConfig } from '../../packages/server/src/skill-install/claude-desktop-file.js';
// Sync fs from node:fs, matching the convention in tests/install/manifest.test.ts
// and tests/install/skill-manifest-sync.test.ts.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const owned = { args: ['/opt/mma/dist/cli/index.js', 'mcp'] };

// Real-filesystem deps for the end-to-end seam test. The config path is derived by
// the REAL resolver from homeDir (no override field — the deps contract has none),
// and `readConfig` is a real disk read rather than an in-memory buffer.
function realFixture(home: string) {
  return {
    platform: 'darwin' as const, homeDir: home, appData: '', localAppData: '',
    execPath: process.execPath,
    resolveEntrypoint: () => join(home, 'dist/cli/index.js'),
    exists: (path: string) => existsSync(path),
    readConfig: (path: string) => (existsSync(path) ? readFileSync(path) : undefined),
    atomicWriteClaudeDesktopConfig,
  };
}

function fixture(initial?: string) {
  let bytes = initial === undefined ? undefined : Buffer.from(initial);
  return {
    platform: 'darwin', homeDir: '/Users/a', appData: 'C:\\Users\\a\\AppData\\Roaming', localAppData: 'C:\\Users\\a\\AppData\\Local',
    execPath: '/opt/node/bin/node', resolveEntrypoint: () => '/opt/mma/dist/cli/index.js', exists: (_path: string) => true,
    readConfig: () => bytes, atomicWriteClaudeDesktopConfig: async ({ nextBytes }: { nextBytes: Buffer }) => { bytes = nextBytes; return null; },
    get bytes() { return bytes; },
  };
}

describe('Claude Desktop MCP installer', () => {
  // Every other test in this file mocks the write seam at the task boundary, which
  // proves the installer CALLS something shaped like it — not that it is wired to
  // Task I-3's real crash-safe implementation. A second competing write path with
  // the same injected shape would pass all of those. This test closes that gap by
  // wiring the real function against a real temp directory.
  it('routes install and uninstall through the REAL atomic write seam on a real filesystem', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-desktop-'));
    const claudeDir = join(home, 'Library', 'Application Support', 'Claude');
    mkdirSync(claudeDir, { recursive: true });
    // The entrypoint must exist on disk — install refuses otherwise.
    mkdirSync(join(home, 'dist', 'cli'), { recursive: true });
    writeFileSync(join(home, 'dist', 'cli', 'index.js'), '#!/usr/bin/env node\n');
    const deps = realFixture(home);
    const configPath = resolveClaudeDesktopConfigPath(deps);
    expect(configPath).toBe(join(claudeDir, 'claude_desktop_config.json'));
    // Seed an existing config so there are original bytes to back up.
    writeFileSync(configPath, `${JSON.stringify({ preferences: { theme: 'dark' } }, null, 2)}\n`);

    await installClaudeDesktop(deps);
    const afterInstall = JSON.parse(readFileSync(configPath, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(afterInstall.mcpServers.mma).toEqual({ command: deps.execPath, args: [deps.resolveEntrypoint(), 'mcp'] });

    await uninstallClaudeDesktop(deps);
    const afterUninstall = JSON.parse(readFileSync(configPath, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(afterUninstall.mcpServers).not.toHaveProperty('mma');

    // Exactly one backup — taken from the bytes preceding the FIRST byte-changing
    // write, so the second (uninstall) write must not add another — and no temp
    // files left behind.
    const leftovers = readdirSync(claudeDir);
    expect(leftovers.filter((f) => f.startsWith('claude_desktop_config.json.bak.'))).toHaveLength(1);
    expect(leftovers.filter((f) => /\.tmp|\.temp|\.mma-desktop-/.test(f))).toHaveLength(0);
  });

  // Uninstall must recognise the no-`command` owned shape INDEPENDENTLY. Running
  // install first would leave an entry that has `command`, so uninstall would
  // never actually see a no-`command` fixture and a recogniser wrongly requiring
  // `command` would still pass.
  it('uninstalls a pre-existing owned entry that has no command key', async () => {
    const deps = fixture(JSON.stringify({ preferences: { theme: 'dark' }, mcpServers: { mma: owned, other: { command: 'x' } } }, null, 2) + '\n');
    await uninstallClaudeDesktop(deps);
    const written = JSON.parse(deps.bytes!.toString()) as { preferences: unknown; mcpServers: Record<string, unknown> };
    expect(written.mcpServers).not.toHaveProperty('mma');
    expect(written.mcpServers.other).toEqual({ command: 'x' });
    expect(written.preferences).toEqual({ theme: 'dark' });
  });

  it('merges the portable Node launch entry without credentials and uses the macOS path', async () => {
    const deps = fixture(JSON.stringify({ preferences: { theme: 'dark' }, mcpServers: { other: { command: 'x' } } }));
    await installClaudeDesktop(deps);
    const written = JSON.parse(deps.bytes!.toString()) as { preferences: unknown; mcpServers: Record<string, unknown> };
    expect(resolveClaudeDesktopConfigPath(deps)).toBe('/Users/a/Library/Application Support/Claude/claude_desktop_config.json');
    expect(written.preferences).toEqual({ theme: 'dark' });
    expect(written.mcpServers.mma).toEqual({ command: '/opt/node/bin/node', args: ['/opt/mma/dist/cli/index.js', 'mcp'] });
    expect(JSON.stringify(written)).not.toMatch(/token|env|npx/i);
    expect(deps.bytes!.toString()).toMatch(/\n$/);
  });

  it('creates a fresh document containing only mcpServers and the entry when no config file exists', async () => {
    const deps = fixture(); // no initial bytes → config absent
    await installClaudeDesktop(deps);
    expect(JSON.parse(deps.bytes!.toString())).toEqual({
      mcpServers: { mma: { command: '/opt/node/bin/node', args: ['/opt/mma/dist/cli/index.js', 'mcp'] } },
    });
  });

  it('refuses install without changing bytes when the resolved Node binary or entrypoint does not exist on disk', async () => {
    const original = JSON.stringify({ mcpServers: {} });
    const missingNode = fixture(original);
    missingNode.exists = (p: string) => p !== missingNode.execPath;
    await expect(installClaudeDesktop(missingNode)).rejects.toThrow();
    expect(missingNode.bytes!.toString()).toBe(original);

    const missingEntrypoint = fixture(original);
    missingEntrypoint.exists = (p: string) => p !== missingEntrypoint.resolveEntrypoint();
    await expect(installClaudeDesktop(missingEntrypoint)).rejects.toThrow();
    expect(missingEntrypoint.bytes!.toString()).toBe(original);
  });

  it('updates and removes the no-command owned edge fixture, but refuses each foreign shape byte-for-byte', async () => {
    const removable = fixture(JSON.stringify({ mcpServers: { mma: owned, sibling: { url: 'keep' } } }));
    await installClaudeDesktop(removable);
    await uninstallClaudeDesktop(removable);
    expect(JSON.parse(removable.bytes!.toString())).toEqual({ mcpServers: { sibling: { url: 'keep' } } });
    for (const mma of [{ ...owned, env: {} }, { command: 'x', args: ['/opt/mma/dist/cli/index.js', 'nope'] }, { command: 'x', args: ['relative/index.js', 'mcp'] }]) {
      const original = JSON.stringify({ mcpServers: { mma } });
      const foreign = fixture(original);
      await expect(installClaudeDesktop(foreign)).rejects.toThrow();
      await expect(uninstallClaudeDesktop(foreign)).rejects.toThrow();
      expect(foreign.bytes!.toString()).toBe(original);
    }
  });

  // The merge is computed from bytes read earlier and the rename replaces the WHOLE
  // file. If Claude Desktop saves in that window, renaming the stale merge would
  // silently discard the user's newest edit — the exact outcome this module exists to
  // prevent. Atomic replacement prevents a torn file, not a stale one.
  it('refuses without writing when the config changes between read and write', async () => {
    const first = JSON.stringify({ preferences: { theme: 'dark' }, mcpServers: {} }, null, 2) + '\n';
    const secondWriter = JSON.stringify({ preferences: { theme: 'light' }, mcpServers: {} }, null, 2) + '\n';
    let reads = 0;
    let written: Buffer | undefined;
    const deps = {
      platform: 'darwin', homeDir: '/Users/a', appData: '', localAppData: '',
      execPath: '/opt/node/bin/node', resolveEntrypoint: () => '/opt/mma/dist/cli/index.js',
      exists: (_p: string) => true,
      // First read = the merge source; the guard's re-read sees someone else's newer save.
      readConfig: () => Buffer.from(++reads === 1 ? first : secondWriter),
      atomicWriteClaudeDesktopConfig: async ({ nextBytes }: { nextBytes: Buffer }) => { written = nextBytes; return null; },
    };
    await expect(installClaudeDesktop(deps)).rejects.toThrow(/changed on disk/);
    expect(written).toBeUndefined(); // the writer was never reached

    reads = 0;
    await expect(uninstallClaudeDesktop({ ...deps, readConfig: () => Buffer.from(++reads === 1 ? JSON.stringify({ mcpServers: { mma: owned } }) : secondWriter) })).rejects.toThrow(/changed on disk/);
  });

  it('detects only Desktop evidence and resolves the Windows config location', async () => {
    const deps = fixture();
    deps.platform = 'win32';
    deps.appData = 'C:\\Users\\a\\AppData\\Roaming';
    deps.localAppData = 'C:\\Users\\a\\AppData\\Local';
    deps.exists = (p: string) => p === 'C:\\Users\\a\\AppData\\Local\\Programs\\Claude';
    expect(resolveClaudeDesktopConfigPath(deps)).toBe('C:\\Users\\a\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
    expect(detectClaudeDesktop(deps)).toEqual(expect.objectContaining({ detected: true, support: 'mcp-only' }));
  });

  it.each([
    ['{', /offset|line|column/i], ['[]', /root.*array/i], ['{"mcpServers":[]}', /mcpServers.*array/i], ['{"mcpServers":{"mma":null}}', /mcpServers\.mma.*null/i],
  ])('refuses unusable config %s without changing bytes', async (raw, message) => {
    const deps = fixture(raw);
    await expect(installClaudeDesktop(deps)).rejects.toThrow(message);
    expect(deps.bytes!.toString()).toBe(raw);
  });
});
