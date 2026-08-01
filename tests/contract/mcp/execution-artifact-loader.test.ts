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

  it('exports the frozen resource constants used by both tool-surface.ts and mcp-adapter.ts', async () => {
    readFileSyncMock.mockReturnValue('<html/>');
    const mod = await import('../../../packages/server/src/mcp/execution-artifact.js');
    expect(mod.EXECUTION_RESOURCE_URI).toBe('ui://mma/execution.html');
    expect(mod.EXECUTION_RESOURCE_MIME_TYPE).toBe('text/html;profile=mcp-app');
    expect(mod.RESOURCE_NOT_FOUND).toBe(-32002);
  });
});