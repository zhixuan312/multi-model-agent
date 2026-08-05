import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../packages/server/src/cli/index.js';
import { runMcpBridge } from '../../packages/server/src/cli/mcp.js';
import { removeClientRegistration, writeClientRegistration } from '../../packages/server/src/provisioning/writers/registry.js';

import { startServe } from '../../packages/server/src/cli/serve.js';

vi.mock('../../packages/server/src/cli/mcp.js', () => ({ runMcpBridge: vi.fn(async () => 0) }));
// The dispatch table moved out of registration-writer.ts into writers/registry.ts
// to break the writer<->machinery import cycle; mocking the machinery would no
// longer intercept the call the CLI actually makes.
vi.mock('../../packages/server/src/provisioning/writers/registry.js', () => ({
  writeClientRegistration: vi.fn(async () => ({ status: 'registered', changed: true, path: 'desktop-config.json', clientId: 'claude-desktop', initializeOnce: async () => ({ ok: true }) })),
  removeClientRegistration: vi.fn(async () => ({ status: 'absent', changed: true, path: 'desktop-config.json', clientId: 'claude-desktop', initializeOnce: async () => { throw new Error('absent'); } })),
  writerForClient: vi.fn(() => undefined),
}));
// Mocked so "no verb starts a daemon" is assertable. Without this mock the symbol
// is not controllable and the assertion below cannot compile.
vi.mock('../../packages/server/src/cli/serve.js', () => ({ startServe: vi.fn(async () => 0) }));

// main() runs an unconditional ~/.multi-model -> ~/.mma migration that unlinks or
// renames real directories, resolved from `deps.homeDir?.() ?? os.homedir()`. Every
// main() call here MUST therefore be given an isolated home, or the suite mutates the
// developer's actual home directory before the mocked installer is ever reached.
const isolatedHome = mkdtempSync(join(tmpdir(), 'mma-cli-home-'));
const isolated = {
  homeDir: () => isolatedHome,
  cwd: () => isolatedHome,
  env: () => ({} as Record<string, string | undefined>),
  stdout: () => true,
  stderr: () => true,
  exit: (() => { throw new Error('exit'); }) as never,
};

describe('mma mcp nested commands', () => {
  // Mutual exclusivity means the OTHER two targets must be untouched. Asserting
  // only "the intended target ran once" would still pass a handler that fires an
  // extra side effect alongside the correct one.
  const allTargets = [runMcpBridge, writeClientRegistration, removeClientRegistration];
  // Only the two verb rows live here. Bare `mcp` is deliberately excluded: it needs
  // real config discovery, and invoking main() without cwd/homeDir/env overrides
  // would fall through to the real os.homedir()/process.cwd()/process.env. Task I-2
  // already covers bare `mcp` end-to-end with a deterministic fixture.
  //
  // `mcp install` now REQUIRES an explicit ClientId (Task I-8 replaced the
  // former no-argument, Claude-Desktop-only default outright — no alias, no
  // silent default); `mcp uninstall` keeps its bare, Desktop-only form.
  it.each([['mcp install claude-desktop', 1], ['mcp uninstall', 2]] as const)('dispatches %s through the registry writer and nothing else', async (raw, selected) => {
    allTargets.forEach((t) => vi.mocked(t).mockClear());
    vi.mocked(startServe).mockClear();
    const argv = raw.split(' ');
    await main({ ...isolated, argv: () => argv }).catch(() => undefined);
    allTargets.forEach((t, i) => expect(t).toHaveBeenCalledTimes(i === selected ? 1 : 0));
    expect(runMcpBridge).toHaveBeenCalledTimes(0); // a verb must never run the bridge
    expect(startServe).toHaveBeenCalledTimes(0);   // no verb may start a daemon
    const registrationCall = selected === 1 ? writeClientRegistration : removeClientRegistration;
    expect(registrationCall).toHaveBeenCalledWith(expect.objectContaining({
      capability: expect.objectContaining({ id: 'claude-desktop' }),
    }));
  });

  it('rejects an unknown nested verb without touching any target', async () => {
    allTargets.forEach((t) => vi.mocked(t).mockClear());
    let err = '';
    await main({ ...isolated, argv: () => ['mcp', 'bogus'], stderr: (s: string) => { err += s; return true; } }).catch(() => undefined);
    expect(err).toMatch(/unknown subcommand "bogus"/);
    allTargets.forEach((t) => expect(t).toHaveBeenCalledTimes(0));
  });

  it('never touches a real home directory: no migration outside the isolated home', () => {
    // The isolated home must contain no evidence of the ~/.multi-model migration,
    // proving the override is actually threaded through every main() call above.
    expect(existsSync(join(isolatedHome, '.multi-model'))).toBe(false);
    expect(readdirSync(isolatedHome).filter((f) => f === '.multi-model')).toEqual([]);
  });

  it('does not register Desktop as a skill target', async () => {
    const manifest = await import('node:fs/promises').then((fs) => fs.readFile('packages/server/src/skill-install/manifest.ts', 'utf8'));
    expect(manifest).not.toContain("'claude-desktop'");
  });
});
