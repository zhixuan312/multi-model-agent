// Plugin builder — the marketplace-distributable artifact.
//
// The committed `plugin/` directory is GENERATED from the packaged skills, so
// the highest-value assertions are (a) it never carries a secret, and (b) the
// committed copy has not drifted from what the generator produces today.
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPlugin, PLUGIN_NAME, MCP_SERVER_KEY, pluginComponentName, rewriteSkillReferences } from '../../packages/server/src/plugin/build-plugin.js';
import { SUPPORTED_SKILLS, SUPPORTED_COMMANDS } from '../../packages/server/src/skill-install/discover.js';

const SKILL_COMPONENTS = SUPPORTED_SKILLS.map(pluginComponentName);
const COMMAND_COMPONENTS = SUPPORTED_COMMANDS.map(pluginComponentName);

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
    expect(r.skills).toEqual(SKILL_COMPONENTS);
    expect(r.commands).toEqual(COMMAND_COMPONENTS);
    for (const s of SKILL_COMPONENTS) {
      expect(existsSync(join(out, 'skills', s, 'SKILL.md')), `missing skill ${s}`).toBe(true);
    }
    for (const c of COMMAND_COMPONENTS) {
      expect(existsSync(join(out, 'commands', `${c}.md`)), `missing command ${c}`).toBe(true);
    }
  });

  // Claude Code namespaces plugin components as /<plugin>:<component>, and the
  // directory name IS the component name. Keeping the packaged `mma-` prefix
  // would yield `/mma:mma-audit`.
  it('strips the redundant mma- prefix so invocation reads /mma:audit', () => {
    const r = build();
    expect(pluginComponentName('mma-audit')).toBe('audit');
    expect(pluginComponentName('mma-execute-plan')).toBe('execute-plan');
    // The router is packaged under the product name; `/mma:multi-model-agent`
    // is worse than naming it what it is.
    expect(pluginComponentName('multi-model-agent')).toBe('router');

    expect(r.skills).toContain('audit');
    expect(r.skills).toContain('router');
    expect(r.commands).toEqual(['flow', 'breakout']);
    expect(r.skills.some((n) => n.startsWith('mma-'))).toBe(false);
    expect(existsSync(join(out, 'skills', 'mma-audit'))).toBe(false);
  });

  it('rewrites frontmatter name and cross-skill references to the plugin form', () => {
    build();
    const audit = readFileSync(join(out, 'skills', 'audit', 'SKILL.md'), 'utf8');
    // Frontmatter must be the BARE component name (it backs the directory).
    expect(audit).toMatch(/^name: audit$/m);

    const router = readFileSync(join(out, 'skills', 'router', 'SKILL.md'), 'utf8');
    expect(router).toMatch(/^name: router$/m);
    // Prose references become namespaced so they match the real invocation.
    expect(router).toContain('mma:investigate');
    expect(router).not.toMatch(/(?<![\w-])mma-investigate(?![\w-])/);
    // The PRODUCT name must survive untouched — it is not a skill reference.
    expect(router).toContain('multi-model-agent');

    // A command's self-reference becomes its real invocation.
    const flow = readFileSync(join(out, 'commands', 'flow.md'), 'utf8');
    expect(flow).toContain('/mma:flow');
  });

  it('reference rewriting never touches non-skill mma text', () => {
    const names = [...SUPPORTED_SKILLS, ...SUPPORTED_COMMANDS];
    const sample = 'run mma serve; write .mma/plans/x.md in mma-parent; mktemp -t mma-poll.XXXX; use mma-audit';
    const got = rewriteSkillReferences(sample, names);
    expect(got).toContain('mma serve');
    expect(got).toContain('.mma/plans/x.md');
    expect(got).toContain('mma-parent');
    expect(got).toContain('mma-poll.XXXX');
    expect(got).toContain('mma:audit');
    // Longest-first matching: a shorter sibling must not partially consume it.
    expect(rewriteSkillReferences('see mma-journal-record', names)).toBe('see mma:journal-record');
    // Family shorthand follows the rename too.
    expect(rewriteSkillReferences('every mma-* call', names)).toBe('every mma:* call');
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
    const entry = mcp.mcpServers[MCP_SERVER_KEY];
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

  it('inlines @include directives', () => {
    build();
    for (const s of SKILL_COMPONENTS) {
      const body = readFileSync(join(out, 'skills', s, 'SKILL.md'), 'utf8');
      expect(body, `${s} has an unresolved @include`).not.toMatch(/^@include /m);
    }
    // response-shape.md is the surviving shared fragment; confirm it inlines correctly.
    const delegate = readFileSync(join(out, 'skills', 'delegate', 'SKILL.md'), 'utf8');
    expect(delegate).toContain('mma_task_get / mma_task_wait — poll'); // _shared/response-shape.md inlined
  });

  it('rebuild replaces generated trees so a removed skill cannot linger', () => {
    build();
    const stale = join(out, 'skills', 'ghost');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'SKILL.md'), 'removed upstream');
    build();
    expect(existsSync(stale)).toBe(false);
  });

  it('honours a custom daemon port', () => {
    const r = buildPlugin({ outDir: out, version: '9.9.9', port: 9999 });
    expect(r.mcpUrl).toBe('http://127.0.0.1:9999/mcp');
    const mcp = JSON.parse(readFileSync(join(out, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers[MCP_SERVER_KEY].url).toBe('http://127.0.0.1:9999/mcp');
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
      for (const s of SKILL_COMPONENTS) {
        expect(
          readFileSync(join(committed, 'skills', s, 'SKILL.md'), 'utf8'),
          `plugin/skills/${s} is stale — run \`npm run build:plugin\``,
        ).toBe(readFileSync(join(fresh, 'skills', s, 'SKILL.md'), 'utf8'));
      }
      for (const c of COMMAND_COMPONENTS) {
        expect(
          readFileSync(join(committed, 'commands', `${c}.md`), 'utf8'),
          `plugin/commands/${c} is stale — run \`npm run build:plugin\``,
        ).toBe(readFileSync(join(fresh, 'commands', `${c}.md`), 'utf8'));
      }
      expect(readFileSync(join(committed, '.mcp.json'), 'utf8'))
        .toBe(readFileSync(join(fresh, '.mcp.json'), 'utf8'));

      // The generator emits three more files, and every one of them was
      // previously unguarded. The helper script matters most: it is the plugin's
      // entire credential mechanism, and this release added a SECOND writer of it
      // (provisioning/writers/claude-code.ts) from the same HEADERS_HELPER_SH
      // constant — so a stale committed copy would be the one place the constant
      // is not the source of truth.
      expect(
        readFileSync(join(committed, 'scripts', 'mma-mcp-headers.sh'), 'utf8'),
        'plugin/scripts/mma-mcp-headers.sh is stale — run `npm run build:plugin`',
      ).toBe(readFileSync(join(fresh, 'scripts', 'mma-mcp-headers.sh'), 'utf8'));

      // Version is seeded from the committed manifest above, so this compares
      // every OTHER field (name, description, author, homepage, repository,
      // license). The version itself is held in lockstep by the release workflow.
      expect(
        readFileSync(join(committed, '.claude-plugin', 'plugin.json'), 'utf8'),
        'plugin/.claude-plugin/plugin.json is stale — run `npm run build:plugin`',
      ).toBe(readFileSync(join(fresh, '.claude-plugin', 'plugin.json'), 'utf8'));

      // The README embeds its own output directory in the `claude --plugin-dir`
      // line — as a path RELATIVE to cwd, which is the one thing that
      // legitimately differs between a build into `plugin/` and a build into a
      // temp dir. Normalising just that leaves the skill/command counts, the MCP
      // URL, the tool list, and the version line all compared.
      const freshRelative = relative(process.cwd(), fresh) || '.';
      expect(
        readFileSync(join(committed, 'README.md'), 'utf8'),
        'plugin/README.md is stale — run `npm run build:plugin`',
      ).toBe(readFileSync(join(fresh, 'README.md'), 'utf8').split(freshRelative).join('plugin'));
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
