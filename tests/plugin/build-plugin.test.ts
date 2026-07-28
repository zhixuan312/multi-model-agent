// Plugin builder — the marketplace-distributable artifact.
//
// The committed `plugin/` directory is GENERATED from the packaged skills, so
// the highest-value assertions are (a) it never carries a secret, and (b) the
// committed copy has not drifted from what the generator produces today.
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPlugin, PLUGIN_NAME } from '../../packages/server/src/plugin/build-plugin.js';
import { SUPPORTED_SKILLS, SUPPORTED_COMMANDS } from '../../packages/server/src/skill-install/discover.js';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('buildPlugin', () => {
  let out: string;
  beforeEach(() => { out = mkdtempSync(join(tmpdir(), 'mma-plugin-')); });
  afterEach(() => { rmSync(out, { recursive: true, force: true }); });

  function build() {
    return buildPlugin({ outDir: out, version: '9.9.9', port: 7337 });
  }

  it('emits every packaged skill and command', () => {
    const r = build();
    expect(r.skills).toEqual([...SUPPORTED_SKILLS]);
    expect(r.commands).toEqual([...SUPPORTED_COMMANDS]);
    for (const s of SUPPORTED_SKILLS) {
      expect(existsSync(join(out, 'skills', s, 'SKILL.md')), `missing skill ${s}`).toBe(true);
    }
    for (const c of SUPPORTED_COMMANDS) {
      expect(existsSync(join(out, 'commands', `${c}.md`)), `missing command ${c}`).toBe(true);
    }
  });

  it('writes a valid manifest with components at the plugin ROOT, not inside .claude-plugin', () => {
    build();
    const manifest = JSON.parse(readFileSync(join(out, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.name).toBe(PLUGIN_NAME);
    expect(manifest.version).toBe('9.9.9');
    expect(manifest.author).toBeDefined();   // `claude plugin validate` warns without it
    // Claude Code only reads plugin.json from .claude-plugin/; every other
    // component must sit at the root or it is silently not loaded.
    expect(existsSync(join(out, '.claude-plugin', 'skills'))).toBe(false);
    expect(existsSync(join(out, '.claude-plugin', 'commands'))).toBe(false);
  });

  it('registers the MCP server with headersHelper — never a baked-in token', () => {
    const r = build();
    const mcp = JSON.parse(readFileSync(join(out, '.mcp.json'), 'utf8'));
    const entry = mcp.mcpServers[PLUGIN_NAME];
    expect(entry.type).toBe('http');
    expect(entry.url).toBe('http://127.0.0.1:7337/mcp');
    expect(entry.url).toBe(r.mcpUrl);
    // A static `headers` block would mean shipping a secret in the artifact.
    expect(entry.headers).toBeUndefined();
    expect(entry.headersHelper).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(entry.headersHelper).toContain('mma-mcp-headers.sh');
    // Quoted so an install path containing spaces still resolves.
    expect(entry.headersHelper.startsWith('"')).toBe(true);
  });

  it('ships an executable headers helper that emits a JSON string map', () => {
    build();
    const script = join(out, 'scripts', 'mma-mcp-headers.sh');
    expect(statSync(script).mode & 0o111).toBeGreaterThan(0);

    const withEnv = execFileSync(script, { encoding: 'utf8', env: { ...process.env, MMA_AUTH_TOKEN: 'tok-123' } });
    expect(JSON.parse(withEnv)).toEqual({ Authorization: 'Bearer tok-123' });

    // Explicit token file wins over the default location.
    const tokenFile = join(out, 'tok');
    writeFileSync(tokenFile, 'file-tok\n');
    const withFile = execFileSync(script, {
      encoding: 'utf8',
      env: { ...process.env, MMA_AUTH_TOKEN: '', MMA_TOKEN_FILE: tokenFile },
    });
    expect(JSON.parse(withFile)).toEqual({ Authorization: 'Bearer file-tok' });

    // No token anywhere: emit no headers rather than failing the connection,
    // so the user sees an actionable auth error.
    const none = execFileSync(script, {
      encoding: 'utf8',
      env: { ...process.env, MMA_AUTH_TOKEN: '', MMA_TOKEN_FILE: join(out, 'does-not-exist') },
    });
    expect(JSON.parse(none)).toEqual({});
  });

  it('inlines @include directives and leaks no live auth token', () => {
    build();
    for (const s of SUPPORTED_SKILLS) {
      const body = readFileSync(join(out, 'skills', s, 'SKILL.md'), 'utf8');
      expect(body, `${s} has an unresolved @include`).not.toMatch(/^@include /m);
    }
    // The per-client installers substitute the live token into skill text; the
    // plugin is a distributable artifact and must keep the runtime form.
    const delegate = readFileSync(join(out, 'skills', 'mma-delegate', 'SKILL.md'), 'utf8');
    expect(delegate).toContain('${MMA_AUTH_TOKEN:-$(mma print-token)}');
    expect(delegate).toContain('Authentication & identity headers'); // _shared/auth.md inlined
  });

  it('rebuild replaces generated trees so a removed skill cannot linger', () => {
    build();
    const stale = join(out, 'skills', 'mma-ghost');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'SKILL.md'), 'removed upstream');
    build();
    expect(existsSync(stale)).toBe(false);
  });

  it('honours a custom daemon port', () => {
    const r = buildPlugin({ outDir: out, version: '9.9.9', port: 9999 });
    expect(r.mcpUrl).toBe('http://127.0.0.1:9999/mcp');
    const mcp = JSON.parse(readFileSync(join(out, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers[PLUGIN_NAME].url).toBe('http://127.0.0.1:9999/mcp');
  });
});

describe('marketplace catalog', () => {
  it('lists the plugin at a source path that exists in the repo', () => {
    const catalog = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    expect(catalog.name).toBeTruthy();
    expect(catalog.owner?.name).toBeTruthy();
    const entry = catalog.plugins.find((p: { name: string }) => p.name === PLUGIN_NAME);
    expect(entry, `marketplace.json has no "${PLUGIN_NAME}" entry`).toBeDefined();
    // A source path that does not resolve is the documented cause of
    // "Plugin directory not found at path".
    expect(existsSync(resolve(REPO_ROOT, entry.source))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, entry.source, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('the committed plugin/ has not drifted from the generator', () => {
    // Guards the release hazard: editing a skill without re-running
    // `npm run build:plugin` would publish a stale plugin to the marketplace.
    const committed = resolve(REPO_ROOT, 'plugin');
    const fresh = mkdtempSync(join(tmpdir(), 'mma-plugin-drift-'));
    try {
      const committedVersion = JSON.parse(
        readFileSync(join(committed, '.claude-plugin', 'plugin.json'), 'utf8'),
      ).version;
      buildPlugin({ outDir: fresh, version: committedVersion, port: 7337 });
      for (const s of SUPPORTED_SKILLS) {
        expect(
          readFileSync(join(committed, 'skills', s, 'SKILL.md'), 'utf8'),
          `plugin/skills/${s} is stale — run \`npm run build:plugin\``,
        ).toBe(readFileSync(join(fresh, 'skills', s, 'SKILL.md'), 'utf8'));
      }
      for (const c of SUPPORTED_COMMANDS) {
        expect(
          readFileSync(join(committed, 'commands', `${c}.md`), 'utf8'),
          `plugin/commands/${c} is stale — run \`npm run build:plugin\``,
        ).toBe(readFileSync(join(fresh, 'commands', `${c}.md`), 'utf8'));
      }
      expect(readFileSync(join(committed, '.mcp.json'), 'utf8'))
        .toBe(readFileSync(join(fresh, '.mcp.json'), 'utf8'));
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
