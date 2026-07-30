import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../packages/server/src/cli/index.js';
import { runMcpBridge } from '../../packages/server/src/cli/mcp.js';

vi.mock('../../packages/server/src/cli/mcp.js', () => ({ runMcpBridge: vi.fn(async () => 0) }));

describe('mma mcp command registration', () => {
  it('routes bare mcp through the normal config and status URL seam', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-mcp-command-'));
    const config = join(dir, 'mma.json');
    writeFileSync(config, JSON.stringify({
      agents: { standard: { type: 'codex', baseUrl: 'http://mock.local', apiKey: 'x', model: 'x' }, complex: { type: 'codex', baseUrl: 'http://mock.local', apiKey: 'x', model: 'x' } },
      server: { bind: '127.0.0.1', port: 7337, auth: { tokenFile: join(dir, 'token') }, limits: { maxBodyBytes: 1, batchTtlMs: 1, projectCap: 1, maxContextBlockBytes: 1, maxContextBlocksPerProject: 1, shutdownDrainMs: 1 }, stateDir: dir, autoUpdateSkills: false }, diagnostics: { log: false },
    }));
    const exits: number[] = [];
    await main({
      argv: () => ['mcp', '--config', config], cwd: () => '/project', homeDir: () => '/home/test', env: () => ({ MMA_AUTH_TOKEN: 'token' }),
      stdout: () => true, stderr: () => true, exit: ((code: number) => { exits.push(code); throw new Error(`exit:${code}`); }) as never,
    }).catch((error: Error) => expect(error.message).toBe('exit:0'));
    expect(runMcpBridge).toHaveBeenCalledWith(expect.objectContaining({ daemonUrl: 'http://127.0.0.1:7337' }));
    expect(exits).toEqual([0]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not accept a caller-controlled URL and advertises the command in help', async () => {
    const out: string[] = [];
    await main({ argv: () => ['--help'], stdout: (s) => { out.push(s); return true; }, stderr: () => true });
    expect(out.join('')).toContain('mcp');
    expect(await import('node:fs/promises').then((fs) => fs.readFile('packages/server/src/cli/mcp.ts', 'utf8'))).not.toMatch(/MMA_MCP_URL|--url|daemonUrl.*argv/);
  });
});