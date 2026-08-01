import { readFile, access } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';

describe('contract: execution App build configuration', () => {
  it('vite.ui.config.ts uses the verified root/outDir/absolute-input shape', async () => {
    const config = await readFile('packages/server/vite.ui.config.ts', 'utf8');
    expect(config).toMatch(/root:\s*['"]src\/ui\/execution['"]/);
    expect(config).toMatch(/outDir:\s*['"]\.\.\/\.\.\/\.\.\/dist\/ui['"]/);
    expect(config).toMatch(/emptyOutDir:\s*false/);
    expect(config).toMatch(/viteSingleFile\(\)/);
    expect(config).toMatch(/input:\s*resolve\(/);
  });

  it("package.json runs the Vite build FIRST inside build, after prebuild's rm -rf dist", async () => {
    const pkg = JSON.parse(await readFile('packages/server/package.json', 'utf8')) as {
      scripts: Record<string, string>; devDependencies: Record<string, string>;
    };
    expect(pkg.scripts.prebuild).toBe('rm -rf dist');
    expect(pkg.scripts.build.startsWith('vite build --config vite.ui.config.ts')).toBe(true);
    expect(pkg.devDependencies['@modelcontextprotocol/ext-apps']).toBe('1.7.5');
    expect(pkg.devDependencies.vite).toBeDefined();
    expect(pkg.devDependencies['vite-plugin-singlefile']).toBeDefined();
  });

  it('tsconfig excludes the browser-only UI source from the Node tsc pass', async () => {
    const tsconfig = JSON.parse(await readFile('packages/server/tsconfig.json', 'utf8')) as { exclude: string[] };
    expect(tsconfig.exclude).toContain('src/ui/execution');
  });

  it('the HTML entry and bootstrap module exist with the required injection seam', async () => {
    await expect(access('packages/server/src/ui/execution/execution.html')).resolves.toBeUndefined();
    const html = await readFile('packages/server/src/ui/execution/execution.html', 'utf8');
    expect(html).toMatch(/<script[^>]+type=["']module["'][^>]+src=["']\.\/entry\.ts["']/);
    const entry = await readFile('packages/server/src/ui/execution/entry.ts', 'utf8');
    expect(entry).toContain('__MMA_CREATE_APP__');
    expect(entry).toMatch(/from ['"]@modelcontextprotocol\/ext-apps['"]/);
  });
});