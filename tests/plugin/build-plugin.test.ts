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
import { MCP_TOOLS } from '../../packages/server/src/mcp/tool-surface.js';

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
    // Literal, not derived from SUPPORTED_COMMANDS: computing the expectation
    // with the same prefix-stripping under test would pass no matter what the
    // builder does.
    expect(r.commands).toEqual(['flow', 'breakout', 'tldr', 'deck']);
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

    // Two headers: the credential, and the client attribution that is the ONLY
    // signal telling the daemon this traffic came from an Agent Plugins install
    // rather than an anonymous MCP caller.
    const withEnv = execFileSync(script, { encoding: 'utf8', env: { ...process.env, MMA_AUTH_TOKEN: 'tok-123' } });
    expect(JSON.parse(withEnv)).toEqual({ Authorization: 'Bearer tok-123', 'X-MMA-Client': 'agent-plugin' });

    // Explicit token file wins over the default location.
    const tokenFile = join(out, 'tok');
    writeFileSync(tokenFile, 'file-tok\n');
    const withFile = execFileSync(script, {
      encoding: 'utf8',
      env: { ...process.env, MMA_AUTH_TOKEN: '', MMA_TOKEN_FILE: tokenFile },
    });
    expect(JSON.parse(withFile)).toEqual({ Authorization: 'Bearer file-tok', 'X-MMA-Client': 'agent-plugin' });

    // No token anywhere: emit no CREDENTIAL rather than failing the connection,
    // so the user sees an actionable auth error. Attribution still goes out —
    // it carries no secret, and a rejected call is still worth attributing.
    const none = execFileSync(script, {
      encoding: 'utf8',
      env: { ...process.env, MMA_AUTH_TOKEN: '', MMA_TOKEN_FILE: join(out, 'does-not-exist') },
    });
    expect(JSON.parse(none)).toEqual({ 'X-MMA-Client': 'agent-plugin' });
  });

  it('inlines @include directives', () => {
    build();
    for (const s of SKILL_COMPONENTS) {
      const body = readFileSync(join(out, 'skills', s, 'SKILL.md'), 'utf8');
      expect(body, `${s} has an unresolved @include`).not.toMatch(/^@include /m);
    }
    // response-shape.md is the surviving shared fragment; confirm it inlines correctly.
    const delegate = readFileSync(join(out, 'skills', 'delegate', 'SKILL.md'), 'utf8');
    expect(delegate).toContain('mma_execution_get / mma_execution_wait — poll'); // _shared/response-shape.md inlined
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

// ── Agent Plugins 1.0 target ─────────────────────────────────────────────────
//
// A second PACKAGING of the same payload, not a second emitter. The assertions
// that matter are therefore (a) the layout is what an AP client actually reads,
// (b) it still ships no secret, and (c) the skill bytes are identical to the
// Claude Code target — the moment those diverge, there are two sources of truth
// for skill content and the shared-payload design has silently been abandoned.
describe('buildPlugin — agent-plugin target', () => {
  const CLAUDE_NS = 'com.anthropic.claude-code';
  // Verbatim from https://agent-plugins.org/schemas/1.0.0/plugin.schema.json.
  // Inlined rather than fetched: a network-gated assertion is one that silently
  // stops running, and this is a published constant, not a moving target.
  const AP_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

  let out: string;
  beforeEach(() => { out = mkdtempSync(join(tmpdir(), 'mma-ap-')); });
  afterEach(() => { rmSync(out, { recursive: true, force: true }); });

  function buildAp() {
    return buildPlugin({ outDir: out, version: '9.9.9', port: 7337, target: 'agent-plugin' });
  }

  it('defaults to the claude-code target when none is given', () => {
    // The invariant behind every existing caller: `mma plugin build` with no
    // --target, the release script, and the committed plugin/ tree all rely on
    // the untargeted call producing exactly the Claude Code layout.
    const r = buildPlugin({ outDir: out, version: '9.9.9', port: 7337 });
    expect(r.target).toBe('claude-code');
    expect(existsSync(join(out, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(out, 'plugin.json'))).toBe(false);
  });

  it('puts the manifest at the ROOT with the canonical $schema', () => {
    const r = buildAp();
    expect(r.target).toBe('agent-plugin');
    const manifest = JSON.parse(readFileSync(join(out, 'plugin.json'), 'utf8'));
    expect(manifest.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(manifest.name).toBe(PLUGIN_NAME);
    expect(manifest.name).toMatch(AP_NAME_PATTERN);
    expect(manifest.version).toBe('9.9.9');
    // Claude Code's manifest location must NOT also exist: a directory carrying
    // both is ambiguous to any client that auto-detects format by manifest path.
    expect(existsSync(join(out, '.claude-plugin'))).toBe(false);
  });

  it('declares the MCP server over stdio, attributed, with no secret anywhere', () => {
    buildAp();
    const mcp = JSON.parse(readFileSync(join(out, 'mcp.json'), 'utf8'));
    expect(mcp.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    const entry = mcp.mcpServers[MCP_SERVER_KEY];
    expect(entry.type).toBe('stdio');
    expect(entry.command).toBe('mma');
    expect(entry.args).toEqual(['mcp', '--client=agent-plugin']);
    // AP 1.0 permits only ${PLUGIN_ROOT}/${PLUGIN_DATA} interpolation and warns
    // that `headers` values are visible package data. An http entry here would
    // therefore have to carry a literal token — so stdio is not a preference,
    // it is the only transport that can stay secret-free under this spec.
    expect(entry.headers).toBeUndefined();
    expect(entry.url).toBeUndefined();
    // headersHelper is a Claude Code extension with no AP equivalent; emitting
    // it here would be a silently-ignored key that looks like working auth.
    expect(entry.headersHelper).toBeUndefined();
    expect(existsSync(join(out, 'scripts'))).toBe(false);
  });

  it('files Claude-Code-only commands under the reverse-domain namespace', () => {
    const r = buildAp();
    expect(r.commands).toEqual(COMMAND_COMPONENTS);
    for (const c of COMMAND_COMPONENTS) {
      expect(existsSync(join(out, CLAUDE_NS, 'commands', `${c}.md`)), `missing command ${c}`).toBe(true);
    }
    // AP has no `commands` concept, so a root commands/ dir would be dead weight
    // that only Claude Code could ever read — and Claude Code reads the other
    // package, not this one.
    expect(existsSync(join(out, 'commands'))).toBe(false);
  });

  it('emits skill bytes IDENTICAL to the claude-code target', () => {
    buildAp();
    const claude = mkdtempSync(join(tmpdir(), 'mma-cc-'));
    try {
      buildPlugin({ outDir: claude, version: '9.9.9', port: 7337 });
      for (const s of SKILL_COMPONENTS) {
        expect(
          readFileSync(join(out, 'skills', s, 'SKILL.md'), 'utf8'),
          `skill ${s} differs between targets — the payload has forked`,
        ).toBe(readFileSync(join(claude, 'skills', s, 'SKILL.md'), 'utf8'));
      }
      for (const c of COMMAND_COMPONENTS) {
        expect(
          readFileSync(join(out, CLAUDE_NS, 'commands', `${c}.md`), 'utf8'),
          `command ${c} differs between targets — the payload has forked`,
        ).toBe(readFileSync(join(claude, 'commands', `${c}.md`), 'utf8'));
      }
    } finally {
      rmSync(claude, { recursive: true, force: true });
    }
  });

  it('carries no credential in any emitted file', () => {
    buildAp();
    for (const f of ['plugin.json', 'mcp.json', 'README.md']) {
      const text = readFileSync(join(out, f), 'utf8');
      expect(text).not.toMatch(/Bearer\s+\S/);
      expect(text).not.toMatch(/Authorization"\s*:\s*"[^$]/);
    }
  });
});

/**
 * The README's "What it installs" section must describe what was installed.
 *
 * Its three bullets are three different constructions and only two were derived. The tool list
 * comes from `MCP_TOOLS` with a comment explaining that a hand-maintained one "silently rots every
 * time a specification adds operations". One line below that warning, the COMMANDS bullet had a
 * computed count and a hardcoded pair of examples — so adding `/mma:tldr` and `/mma:deck` produced
 * "**4 commands** — explicitly invoked (`/mma:flow`, `/mma:breakout`)": a list that contradicts the
 * number beside it, with no `…` to mark it as a sample the way the skills bullet does.
 */
describe('plugin README describes the plugin it shipped with', () => {
  let out: string;
  let result: ReturnType<typeof buildPlugin>;
  let readme: string;

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), 'mma-plugin-readme-'));
    result = buildPlugin({ outDir: out, version: '9.9.9', port: 7337 });
    readme = readFileSync(join(out, 'README.md'), 'utf8');
  });

  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('states the counts it actually emitted', () => {
    expect(readme).toContain(`**${result.skills.length} skills**`);
    expect(readme).toContain(`**${result.commands.length} commands**`);
  });

  it('names every command it emitted, not a sample of them', () => {
    for (const command of result.commands) {
      expect(readme, `README omits /mma:${command} while claiming ${result.commands.length} commands`)
        .toContain(`\`/mma:${command}\``);
    }
  });

  it('names every MCP tool it exposes', () => {
    for (const tool of MCP_TOOLS) {
      expect(readme, `README omits ${tool.name}`).toContain(`\`${tool.name}\``);
    }
  });
});