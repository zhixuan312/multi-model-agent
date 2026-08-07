import { describe, it, expect, vi, beforeEach } from 'vitest';

const { readFileSyncMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: readFileSyncMock }));

describe('contract: execution-artifact loader', () => {
  beforeEach(() => { vi.resetModules(); readFileSyncMock.mockReset(); });

  it('degrades to a marked placeholder and does not throw when the artifact is absent', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    readFileSyncMock.mockImplementation(() => { throw err; });
    const mod = await import('../../../packages/server/src/mcp/execution-artifact.js');
    const artifact = mod.getExecutionArtifact();
    expect(artifact.available).toBe(false);
    expect(artifact.html).toContain('not built');
  });

  it('loads real bytes once and serves the same cached object on every subsequent call', async () => {
    readFileSyncMock.mockReturnValue('<html>real bundle</html>');
    const mod = await import('../../../packages/server/src/mcp/execution-artifact.js');
    const first = mod.getExecutionArtifact();
    const second = mod.getExecutionArtifact();
    expect(first).toEqual({ available: true, html: '<html>real bundle</html>' });
    expect(second).toBe(first);
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('lets a test-only override force either branch without touching disk', async () => {
    readFileSyncMock.mockImplementation(() => { throw new Error('disk must not be read under override'); });
    const mod = await import('../../../packages/server/src/mcp/execution-artifact.js');
    mod.__setExecutionArtifactOverrideForTests({ available: true, html: '<html>forced</html>' });
    expect(mod.getExecutionArtifact()).toEqual({ available: true, html: '<html>forced</html>' });
    mod.__setExecutionArtifactOverrideForTests({ available: false, html: '<!-- forced unbuilt -->' });
    expect(mod.getExecutionArtifact()).toEqual({ available: false, html: '<!-- forced unbuilt -->' });
    mod.__setExecutionArtifactOverrideForTests(null);
  });

  // The three layouts this module is ever imported from. The installed one is
  // the regression: the resolver used to search for a `/packages/server/`
  // segment that exists ONLY in this monorepo, and fell back to the module path
  // itself — filename and all — for every npm-installed copy. The read then
  // failed, the daemon reported the execution app as unavailable, and every
  // shipped user silently lost the `resources` capability.
  describe('path resolution across install layouts', () => {
    const cases = [
      {
        name: 'npm-installed package (dist/mcp → dist/ui)',
        moduleUrl: 'file:///opt/homebrew/lib/node_modules/@zhixuan92/multi-model-agent/dist/mcp/execution-artifact.js',
        expected: '/opt/homebrew/lib/node_modules/@zhixuan92/multi-model-agent/dist/ui/execution.html',
      },
      {
        name: 'monorepo compiled output (packages/server/dist/mcp → dist/ui)',
        moduleUrl: 'file:///repo/packages/server/dist/mcp/execution-artifact.js',
        expected: '/repo/packages/server/dist/ui/execution.html',
      },
      {
        // Vitest runs this package straight from src/ via the workspace alias.
        // src/ui/execution/execution.html is the UNBUNDLED input, so source
        // mode must still point at the built bundle in the sibling dist/.
        name: 'source/Vitest execution (src/mcp → the sibling dist/ui)',
        moduleUrl: 'file:///repo/packages/server/src/mcp/execution-artifact.ts',
        expected: '/repo/packages/server/dist/ui/execution.html',
      },
    ];

    for (const { name, moduleUrl, expected } of cases) {
      it(`resolves the bundle from ${name}`, async () => {
        readFileSyncMock.mockReturnValue('<html/>');
        const mod = await import('../../../packages/server/src/mcp/execution-artifact.js');
        expect(mod.resolveExecutionArtifactPath(moduleUrl)).toBe(expected);
      });
    }

    it('never embeds the module filename in the resolved path', async () => {
      readFileSyncMock.mockReturnValue('<html/>');
      const mod = await import('../../../packages/server/src/mcp/execution-artifact.js');
      for (const { moduleUrl } of cases) {
        expect(mod.resolveExecutionArtifactPath(moduleUrl)).not.toMatch(/execution-artifact\.(js|ts)/);
      }
    });
  });

  it('exports the frozen resource constants used by both tool-surface.ts and mcp-adapter.ts', async () => {
    readFileSyncMock.mockReturnValue('<html/>');
    const mod = await import('../../../packages/server/src/mcp/execution-artifact.js');
    expect(mod.EXECUTION_RESOURCE_URI).toBe('ui://mma/execution.html');
    expect(mod.EXECUTION_RESOURCE_MIME_TYPE).toBe('text/html;profile=mcp-app');
    expect(mod.RESOURCE_NOT_FOUND).toBe(-32002);
  });
});