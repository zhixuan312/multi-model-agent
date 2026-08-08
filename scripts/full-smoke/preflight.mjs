import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE_URL, IDENTITY_FILE, APPROVED_DB_HOSTS, QUEUE_FILE, DIAG_DIR, HOME_MM } from './config.mjs';
import { readToken } from './http.mjs';

// The packaged skill surface the running server installs to its clients
// (dev layout: the live server reads skills from here).
const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'server', 'src', 'skills');

/**
 * Skill-surface release gate. Guards the design→explore/brainstorm split so a
 * revert or regression can never pass the release smoke silently. This feature
 * is orchestration-only (no HTTP task type, no skill-listing endpoint), so it
 * is asserted against the packaged surface rather than a dispatch.
 */
function skillSurfaceGate() {
  const dirs = existsSync(SKILLS_ROOT)
    ? readdirSync(SKILLS_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  const has = (name) => dirs.includes(name);
  const read = (name) => {
    const p = join(SKILLS_ROOT, name, 'SKILL.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  };

  if (has('mma-design')) {
    throw new AbortError('skill-surface', 'mma-design is still packaged',
      'the design skill was split into mma-explore + mma-brainstorm — remove packages/server/src/skills/mma-design');
  }
  for (const required of ['mma-explore', 'mma-brainstorm']) {
    if (!has(required)) {
      throw new AbortError('skill-surface', `${required} is missing from the packaged surface`,
        `create packages/server/src/skills/${required}/SKILL.md`);
    }
  }

  const explore = read('mma-explore');
  for (const marker of ['.mma/explorations/', '## Background', '## Current state', '## Rough direction', 'in ONE message']) {
    if (!explore.includes(marker)) {
      throw new AbortError('skill-surface', `mma-explore SKILL.md missing marker: ${marker}`,
        'mma-explore must braindump → fan out → write exploration.md (Background · Current state · Rough direction)');
    }
  }

  const brainstorm = read('mma-brainstorm');
  for (const marker of ['Name the destination', 'one decision at a time', 'mma-spec']) {
    if (!brainstorm.includes(marker)) {
      throw new AbortError('skill-surface', `mma-brainstorm SKILL.md missing marker: ${marker}`,
        'mma-brainstorm must grill (wayfinder-style) then dispatch mma-spec');
    }
  }

  const flow = read('mma-flow');
  if (flow.includes('mma-design') || !flow.includes('D3 — Spec') || !flow.includes('mma-explore') || !flow.includes('mma-brainstorm')) {
    throw new AbortError('skill-surface', 'mma-flow is not wired to D1 explore → D2 brainstorm → D3 spec',
      'update packages/server/src/skills/mma-flow/SKILL.md Design phase (remove mma-design, add D3 + exploration stage)');
  }
  if (!flow.includes('once per repo') || !flow.includes('Common: Multi-repo')) {
    throw new AbortError('skill-surface', 'mma-flow B5 is missing the one-request-per-repo dispatch invariant',
      'update packages/server/src/skills/mma-flow/SKILL.md B5 / Common: Multi-repo to encode one execute_plan request per repo (tasks[] only partitions multi-repo plans)');
  }

  // mma-breakout is orchestration/command-only (no HTTP task type, no dispatch
  // scenario), so — like mma-flow — it is gated against the packaged surface:
  // the interactive breakout lifecycle + one-shot journal close-out must stay intact,
  // and it must never grow a backend route.
  if (!has('mma-breakout')) {
    throw new AbortError('skill-surface', 'mma-breakout is missing from the packaged surface',
      'create packages/server/src/skills/mma-breakout/SKILL.md');
  }
  const breakout = read('mma-breakout');
  for (const marker of [
    '# /mma-breakout',
    'Claude Code command',
    'run_in_background: true',
    '@name',
    'exactly one `journal_record` task',
    'TaskStop',
    "raw `.output` transcript",
    'No server schema, task type, or HTTP route is added',
    'client-side only',
  ]) {
    if (!breakout.includes(marker)) {
      throw new AbortError('skill-surface', `mma-breakout SKILL.md missing marker: ${marker}`,
        'mma-breakout must keep the isolated breakout lifecycle + one-shot journal close-out and stay client-side only');
    }
  }
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Claude Code plugin release gate (5.16.0). The committed `plugin/` tree is a
 * GENERATED artifact published through the repo's own marketplace, so a release
 * must never ship it stale or — far worse — carrying a secret. Like the
 * skill-surface gate this is asserted against files, not a dispatch: there is no
 * HTTP route for plugin packaging.
 */
function pluginSurfaceGate() {
  const pluginDir = join(REPO_ROOT, 'plugin');
  const marketplace = join(REPO_ROOT, '.claude-plugin', 'marketplace.json');

  if (!existsSync(marketplace)) {
    throw new AbortError('plugin-surface', `missing ${marketplace}`,
      'the repo root must carry .claude-plugin/marketplace.json to act as a marketplace');
  }
  const catalog = JSON.parse(readFileSync(marketplace, 'utf8'));
  const entry = (catalog.plugins ?? []).find((p) => p.name === 'mma');
  if (!entry) {
    throw new AbortError('plugin-surface', 'marketplace.json has no "mma" plugin entry',
      'add the mma entry with a source path pointing at ./plugin');
  }
  // A source that does not resolve is the documented cause of the install-time
  // "Plugin directory not found at path" failure.
  const manifest = join(REPO_ROOT, entry.source, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifest)) {
    throw new AbortError('plugin-surface', `marketplace source ${entry.source} has no .claude-plugin/plugin.json`,
      'run `npm run build:plugin` and commit ./plugin');
  }

  // Components must live at the plugin ROOT — only plugin.json belongs inside
  // .claude-plugin/, and a misplaced tree loads silently as an empty plugin.
  for (const required of ['skills', 'commands', 'scripts', '.mcp.json']) {
    if (!existsSync(join(pluginDir, required))) {
      throw new AbortError('plugin-surface', `plugin/${required} is missing`,
        'run `npm run build:plugin` — components belong at the plugin root');
    }
  }

  // The mma- prefix is the FLAT-install namespace; a plugin namespaces its own
  // components, so keeping it would produce /mma:mma-audit.
  const skillDirs = readdirSync(join(pluginDir, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  const doubled = skillDirs.filter((n) => n.startsWith('mma-'));
  if (doubled.length > 0) {
    throw new AbortError('plugin-surface', `plugin skills still carry the mma- prefix: ${doubled.join(', ')}`,
      'the plugin namespaces components already — invocation must read /mma:audit, not /mma:mma-audit');
  }
  if (!skillDirs.includes('audit') || !skillDirs.includes('router')) {
    throw new AbortError('plugin-surface', `plugin skills look wrong: ${skillDirs.join(', ')}`,
      'expected bare component names (audit, delegate, router, …) — run `npm run build:plugin`');
  }

  // Auth: the artifact must register the MCP server WITHOUT embedding a token.
  const mcp = JSON.parse(readFileSync(join(pluginDir, '.mcp.json'), 'utf8'));
  const server = mcp.mcpServers?.daemon;
  if (!server || server.type !== 'http' || !server.headersHelper) {
    throw new AbortError('plugin-surface', `plugin .mcp.json mma entry=${JSON.stringify(server)}`,
      'the MCP entry must be an http server using headersHelper');
  }
  if (server.headers) {
    throw new AbortError('plugin-surface', 'plugin .mcp.json pins static headers',
      'use headersHelper — a static headers block would ship a secret in a distributable artifact');
  }

  // Hard secret gate: the live daemon token must appear NOWHERE in the artifact.
  // Nothing substitutes a token into skill text any more — skills are MCP-only —
  // so this is a backstop against a future regression, not a live risk.
  const token = (() => { try { return readToken(); } catch { return null; } })();
  if (token && token.length > 8) {
    const offenders = [];
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) { walk(p); continue; }
        let body = '';
        try { body = readFileSync(p, 'utf8'); } catch { continue; }
        if (body.includes(token)) offenders.push(p);
      }
    };
    walk(pluginDir);
    if (offenders.length > 0) {
      throw new AbortError('plugin-secret', `live auth token found in ${offenders.length} plugin file(s): ${offenders[0]}`,
        'the plugin is distributable — no generated file may contain the live token');
    }
  }
}

/**
 * Agent Plugins 1.0 surface release gate.
 *
 * The AP package is NOT committed — unlike `plugin/`, it has no marketplace to be
 * stale in, because AP 1.0 deliberately defines no install protocol. So this gate
 * GENERATES it from the built CLI, which is the stronger check anyway: it proves
 * the artifact a released `mma` produces is correct, not that a checked-in copy
 * still looks right.
 *
 * Three things can silently break a release here, and each has an assertion:
 *   1. The payload forks. Two targets means two chances for skill content to
 *      drift; byte-equality between them is the only durable proof it hasn't.
 *   2. The declared MCP entry stops working. `mcp.json` names `mma mcp --client=…`;
 *      if the CLI ever drops that flag, every AP install fails at connect time and
 *      nothing else in this suite would notice. So the entry is not just parsed —
 *      it is EXECUTED against the live daemon, exactly as an AP client would.
 *   3. A secret reaches a distributable artifact.
 */
/**
 * Packaged-layout release gate (6.2.1).
 *
 * WHAT IT PROVES. That the daemon can find the files it ships when it is not
 * running out of this monorepo. Everything else in this suite — every unit test,
 * every scenario — exercises the repo layout, where the path
 * `.../packages/server/dist/...` holds. An installed copy lives at
 * `<prefix>/node_modules/@zhixuan92/multi-model-agent/dist/...`, and any code that
 * derives a path from an absolute-path landmark instead of from its own module
 * location behaves DIFFERENTLY there.
 *
 * WHY IT EXISTS. That is not hypothetical. The execution-app resolver searched its
 * module path for a `/packages/server/` segment and fell back to the module path
 * itself — filename included — when absent. Correct in the monorepo, broken in
 * every published build, so the App resource was unreachable for every real user
 * while the entire suite ran green. A whole class of defect was invisible because
 * no gate had ever loaded this code from a non-repo path.
 *
 * WHY A COPY. Node resolves symlinks before setting `import.meta.url`, so a
 * symlinked layout would report the real repo path and the gate would silently
 * test nothing. The copy is ~2.7 MB and takes well under a second.
 */
function packagedLayoutGate() {
  const dist = join(REPO_ROOT, 'packages', 'server', 'dist');
  if (!existsSync(dist)) {
    throw new AbortError('packaged-layout', `no built output at ${dist}`, 'run `npm run build` before the smoke');
  }

  const root = join(tmpdir(), `mma-smoke-pkg-${process.pid}-${Date.now()}`);
  // The real installed shape, and deliberately free of a `packages/server` segment.
  const pkgDir = join(root, 'node_modules', '@zhixuan92', 'multi-model-agent');
  try {
    cpSync(dist, join(pkgDir, 'dist'), { recursive: true });

    const artifactModule = join(pkgDir, 'dist', 'mcp', 'execution-artifact.js');
    if (!existsSync(artifactModule)) {
      throw new AbortError('packaged-layout', `copied tree has no ${artifactModule}`,
        'the build must emit dist/mcp/execution-artifact.js');
    }
    if (!existsSync(join(pkgDir, 'dist', 'ui', 'execution.html'))) {
      throw new AbortError('packaged-layout', 'the built tree carries no dist/ui/execution.html',
        'run `npm run build` — the vite step emits the execution app');
    }

    // Loaded in a child process: this module caches its artifact at module scope on
    // first import, so importing it here would either hit a cache from elsewhere in
    // the harness or poison one for later.
    const probe = `
      import { getExecutionArtifact, resolveExecutionArtifactPath } from ${JSON.stringify(pathToFileURL(artifactModule).href)};
      const a = getExecutionArtifact();
      process.stdout.write(JSON.stringify({
        available: a.available,
        bytes: a.html.length,
        resolved: resolveExecutionArtifactPath(${JSON.stringify(pathToFileURL(artifactModule).href)}),
      }));
    `;
    let result;
    try {
      result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' }));
    } catch (e) {
      throw new AbortError('packaged-layout', `could not load the artifact module from a packaged layout: ${String(e.stderr || e.message || e)}`,
        'dist/mcp/execution-artifact.js must import cleanly outside the monorepo');
    }

    if (!result.available) {
      throw new AbortError('packaged-layout',
        `the execution app reads as UNAVAILABLE from an installed layout (resolved=${result.resolved})`,
        'resolve bundled assets relative to the module\'s own directory — an absolute-path landmark '
        + 'like /packages/server/ exists only in this repo, so a published build finds nothing');
    }
    if (result.bytes < 100000) {
      throw new AbortError('packaged-layout', `the packaged artifact is ${result.bytes} bytes — that is the unbuilt placeholder, not the bundle`,
        'run `npm run build` so the vite singlefile step emits the real execution app');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function agentPluginSurfaceGate() {
  const cliPath = join(REPO_ROOT, 'packages', 'server', 'dist', 'cli', 'index.js');
  if (!existsSync(cliPath)) {
    throw new AbortError('agent-plugin-surface', `no built CLI at ${cliPath}`, 'run `npm run build` before the smoke');
  }

  const stamp = `${process.pid}-${Date.now()}`;
  const apDir = join(tmpdir(), `mma-smoke-ap-${stamp}`);
  const ccDir = join(tmpdir(), `mma-smoke-cc-${stamp}`);
  const build = (outDir, target) => {
    try {
      execFileSync('node', [cliPath, 'plugin', 'build', '--target', target, '--out', outDir], { stdio: 'pipe' });
    } catch (e) {
      throw new AbortError('agent-plugin-surface', `\`mma plugin build --target=${target}\` failed: ${String(e.stderr || e.message || e)}`,
        'the plugin emitter must build both targets from the built CLI');
    }
  };

  try {
    build(apDir, 'agent-plugin');
    build(ccDir, 'claude-code');

    // Layout. AP reads the manifest at the ROOT under its own $schema; a package
    // that also carried .claude-plugin/ would be ambiguous to any client that
    // auto-detects format by manifest path (VS Code does exactly that).
    const manifestPath = join(apDir, 'plugin.json');
    if (!existsSync(manifestPath)) {
      throw new AbortError('agent-plugin-surface', 'agent-plugin package has no root plugin.json',
        'AP 1.0 requires the manifest at the package root');
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') {
      throw new AbortError('agent-plugin-surface', `plugin.json $schema=${manifest.$schema}`,
        'the manifest must declare the canonical Agent Plugins 1.0 schema, or clients fall back to a vendor format');
    }
    // Verbatim from the published schema — a name that fails it is rejected at install.
    if (!/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(String(manifest.name ?? ''))) {
      throw new AbortError('agent-plugin-surface', `plugin.json name=${manifest.name}`,
        'the manifest name must satisfy the Agent Plugins name pattern');
    }
    if (existsSync(join(apDir, '.claude-plugin'))) {
      throw new AbortError('agent-plugin-surface', 'agent-plugin package also carries .claude-plugin/',
        'one package, one manifest — a dual-manifest tree is ambiguous to format-detecting clients');
    }
    for (const required of ['skills', 'mcp.json', join('com.anthropic.claude-code', 'commands')]) {
      if (!existsSync(join(apDir, required))) {
        throw new AbortError('agent-plugin-surface', `agent-plugin package is missing ${required}`,
          'skills/ and mcp.json sit at the root; Claude-Code-only commands live under the reverse-domain namespace');
      }
    }

    // (0) The COMMITTED Claude Code tree must equal what the BUILT CLI produces.
    // A vitest contract test already compares it against the source emitter; this
    // is the same invariant one layer down, and only this layer can catch a dist
    // that no longer matches src — which is what actually ships. README is skipped:
    // it embeds its own out-dir as a cwd-relative path, so it legitimately differs
    // between a build into plugin/ and one into a temp dir.
    const committedCc = join(REPO_ROOT, 'plugin');
    const compare = (rel) => {
      const a = join(committedCc, rel);
      const b = join(ccDir, rel);
      if (!existsSync(a) || readFileSync(a, 'utf8') !== readFileSync(b, 'utf8')) {
        throw new AbortError('plugin-surface', `committed plugin/${rel} differs from what the built CLI emits`,
          'run `npm run build && npm run build:plugin` and commit ./plugin — the published artifact is stale');
      }
    };
    compare(join('.claude-plugin', 'plugin.json'));
    compare('.mcp.json');
    compare(join('scripts', 'mma-mcp-headers.sh'));

    // (1) The payload must not fork between targets.
    const apSkills = readdirSync(join(apDir, 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const ccSkills = readdirSync(join(ccDir, 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
    if (JSON.stringify(apSkills) !== JSON.stringify(ccSkills)) {
      throw new AbortError('agent-plugin-surface', `skill sets differ: agent-plugin=[${apSkills}] claude-code=[${ccSkills}]`,
        'both targets package the same skills — a difference means the emitter forked');
    }
    for (const name of apSkills) {
      const a = readFileSync(join(apDir, 'skills', name, 'SKILL.md'), 'utf8');
      const c = readFileSync(join(ccDir, 'skills', name, 'SKILL.md'), 'utf8');
      if (a !== c) {
        throw new AbortError('agent-plugin-surface', `skill ${name} differs between targets`,
          'skill content has ONE source — targets may differ in layout and MCP entry, never in payload');
      }
    }

    // (2) The declared MCP entry must actually answer.
    const mcp = JSON.parse(readFileSync(join(apDir, 'mcp.json'), 'utf8'));
    const server = mcp.mcpServers?.daemon;
    if (!server || server.type !== 'stdio' || !Array.isArray(server.args)) {
      throw new AbortError('agent-plugin-surface', `agent-plugin mcp.json daemon entry=${JSON.stringify(server)}`,
        'AP 1.0 has no portable secret mechanism for http headers — the entry must be the stdio bridge');
    }
    if (server.headers || server.url) {
      throw new AbortError('agent-plugin-surface', 'agent-plugin mcp.json declares http fields',
        'headers are visible package data per the spec — an http entry here would ship a token');
    }
    // Run the entry the package declares, substituting only the executable: the
    // package says bare `mma` (resolved from PATH at the user's install), and the
    // released binary IS this CLI. The ARGS are taken verbatim, so a flag the CLI
    // no longer accepts fails right here.
    let frame;
    try {
      const out = execFileSync('node', [cliPath, ...server.args], {
        input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      frame = JSON.parse(out.split('\n').find((l) => l.trim().startsWith('{')) ?? '{}');
    } catch (e) {
      throw new AbortError('agent-plugin-surface', `declared MCP entry \`mma ${server.args.join(' ')}\` failed: ${String(e.stderr || e.message || e)}`,
        'the args in mcp.json must be accepted by the shipped CLI — an AP install has no other way in');
    }
    const toolNames = (frame?.result?.tools ?? []).map((t) => t.name);
    if (!toolNames.includes('mma_run')) {
      throw new AbortError('agent-plugin-surface', `declared MCP entry returned tools=[${toolNames.join(', ')}]`,
        'the stdio bridge must reach the running daemon and expose mma_run');
    }
    // Attribution is the whole reason the flag exists: without it every AP install
    // reports as `other` and adoption is unmeasurable.
    if (!server.args.includes('--client=agent-plugin')) {
      throw new AbortError('agent-plugin-surface', `agent-plugin mcp.json args=${JSON.stringify(server.args)}`,
        'the bridge must be launched with --client=agent-plugin so runs are attributed to the standard');
    }

    // (3) No secret in a distributable artifact.
    const token = (() => { try { return readToken(); } catch { return null; } })();
    if (token && token.length > 8) {
      const offenders = [];
      const walk = (dir) => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, ent.name);
          if (ent.isDirectory()) { walk(p); continue; }
          let body = '';
          try { body = readFileSync(p, 'utf8'); } catch { continue; }
          if (body.includes(token)) offenders.push(p);
        }
      };
      walk(apDir);
      if (offenders.length > 0) {
        throw new AbortError('agent-plugin-secret', `live auth token found in ${offenders.length} agent-plugin file(s): ${offenders[0]}`,
          'the package is distributable — the stdio bridge resolves the token at connect time, so no file may contain it');
      }
    }
  } finally {
    rmSync(apDir, { recursive: true, force: true });
    rmSync(ccDir, { recursive: true, force: true });
  }
}

/**
 * MCP-only surface release gate.
 *
 * The central promise of the client-roster release: no shipped agent instruction
 * teaches an agent to reach MMA over HTTP. REST is fully supported and
 * documented — for Forge and other programmatic callers — but a skill that
 * constructs a `curl` or a `POST /task` gives an agent a second, unreviewed way
 * in, and one that carries a bearer token through prose.
 *
 * Asserted against files rather than a dispatch, like the other surface gates,
 * and against BOTH trees: `packages/server/src/skills` is what the daemon
 * installs, `plugin/` is what the marketplace publishes. A regression that only
 * reached the generated artifact would pass a source-only check.
 */
function mcpOnlySurfaceGate() {
  const PLUGIN_SKILLS = join(REPO_ROOT, 'plugin');
  const TREES = [
    ['packaged skills', SKILLS_ROOT],
    ['generated plugin', PLUGIN_SKILLS],
  ];
  // Each pattern is a way an instruction could hand an agent the HTTP route.
  const FORBIDDEN = [
    [/\bcurl\s+-/, 'a curl invocation'],
    [/POST\s+\/task\b/, 'a POST /task instruction'],
    [/Authorization:\s*Bearer/i, 'an Authorization: Bearer header'],
    [/127\.0\.0\.1:\d+\/task\b/, 'a direct /task URL'],
    [/localhost:\d+\/task\b/, 'a direct /task URL'],
    [/--target=(gemini-cli|codex-cli)\b/, 'a retired client id'],
  ];

  for (const [label, root] of TREES) {
    if (!existsSync(root)) continue;
    const offenders = [];
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) { walk(p); continue; }
        if (!ent.name.endsWith('.md')) continue;
        const body = readFileSync(p, 'utf8');
        for (const [re, what] of FORBIDDEN) {
          if (re.test(body)) offenders.push(`${p} (${what})`);
        }
      }
    };
    walk(root);
    if (offenders.length > 0) {
      throw new AbortError('mcp-only-surface', `${label}: ${offenders.length} file(s) carry HTTP dispatch — ${offenders[0]}`,
        'shipped skills and commands are MCP-only; the unavailable-tool guidance is `mma clients`, never a curl or a REST route');
    }
  }

  // The other half of the promise: when MCP is unavailable, every skill emits the
  // SAME single actionable command. A skill that silently falls back, or names a
  // client-specific command, breaks the shared-root contract (one physical copy
  // in ~/.agents/skills is read by cursor, vscode AND opencode, so no
  // client-specific text can be correct for all of them).
  const skillDirs = readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  const silent = skillDirs.filter((name) => {
    const p = join(SKILLS_ROOT, name, 'SKILL.md');
    return existsSync(p) && !readFileSync(p, 'utf8').includes('mma clients');
  });
  if (silent.length > 0) {
    throw new AbortError('mcp-only-surface', `skills without the unavailable-MCP message: ${silent.join(', ')}`,
      'every packaged skill must emit exactly `mma clients` when mma_run is unavailable');
  }
}

/**
 * Canonical client roster release gate.
 *
 * The roster in `packages/core/src/clients/client-id.ts` is the single source of
 * truth every allowlist, config schema and capability row derives from. This
 * gate proves the LIVE daemon agrees with it — `mma clients` is the user-facing
 * answer, and it must report one record per canonical id, never a retired one.
 */
async function clientRosterGate(token) {
  const expected = ['claude-code', 'claude-desktop', 'codex', 'antigravity', 'cursor', 'vscode', 'opencode', 'windsurf'];

  const cliPath = join(REPO_ROOT, 'packages', 'server', 'dist', 'cli', 'index.js');
  if (!existsSync(cliPath)) {
    throw new AbortError('client-roster', `no built CLI at ${cliPath}`, 'run `npm run build` before the smoke');
  }
  let records;
  try {
    records = JSON.parse(execFileSync('node', [cliPath, 'clients', '--json'], { encoding: 'utf8' }));
  } catch (e) {
    throw new AbortError('client-roster', `\`mma clients --json\` failed: ${String(e.stderr || e.message || e)}`,
      'the clients inventory must be readable without a running daemon');
  }
  const ids = records.map((r) => r.clientId);
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new AbortError('client-roster', `mma clients reported [${ids.join(', ')}]`,
      `expected exactly the canonical roster in CLIENT_IDS order: [${expected.join(', ')}]`);
  }
  for (const record of records) {
    for (const field of ['status', 'skillsInstalled', 'mcpRegistrationStatus', 'declaredState', 'detectedPresence']) {
      if (!(field in record)) {
        throw new AbortError('client-roster', `${record.clientId} inventory record is missing '${field}'`,
          'every inventory record carries the provisioning status plus the roster inputs that decided it');
      }
    }
  }

  // The live daemon's own view must not disagree: GET /health reports drift for
  // any declared client whose provisioning is unresolved.
  const health = await fetch(`${BASE_URL}/health`).then((r) => r.json()).catch(() => null);
  if (!health || !('status' in health)) {
    throw new AbortError('client-roster', `GET /health returned ${JSON.stringify(health)}`,
      'health must report ok|drift derived from the client inventory');
  }
  if (health.status !== 'ok' && health.status !== 'drift') {
    throw new AbortError('client-roster', `GET /health status=${health.status}`, 'expected ok or drift');
  }
  void token;
}

/**
 * Required-tier release gate — a config without `agents.main` must REFUSE to
 * start, and must say which tier is missing.
 *
 * WHY IT EXISTS. `agents.main` became required so the cost baseline is a value
 * the user declares once, never a worker tier the runtime guessed. A guessed
 * baseline priced a run against one of the models that had just executed it and
 * reported a negative saving for runs that saved money. The guess is only
 * actually gone if the daemon refuses the config that used to permit it.
 *
 * WHY THE ERROR TEXT IS ASSERTED, NOT ONLY THE EXIT CODE. Every upgrading user
 * with a two-tier config meets this failure. A non-zero exit that does not name
 * `agents.main` turns a one-line config edit into a support question, so the
 * message is the deliverable, not a detail.
 *
 * WHY IT USES A SCRATCH CONFIG ON A FREE PORT. It must not touch the live
 * daemon this smoke measures. The run is expected to die during config
 * validation, before any bind, but the free port means even a regression that
 * reaches the listener cannot collide with the daemon on 7337.
 */
function requiredTierGate() {
  const cliPath = join(REPO_ROOT, 'packages', 'server', 'dist', 'cli', 'index.js');
  if (!existsSync(cliPath)) {
    throw new AbortError('required-tier', `no built CLI at ${cliPath}`, 'run `npm run build` before the smoke');
  }
  const dir = join(tmpdir(), `mma-smoke-required-tier-${process.pid}`);
  const configPath = join(dir, 'config.json');
  mkdirSync(dir, { recursive: true });
  // Deliberately the pre-6.6.0 shape: the two worker tiers and no `main`.
  writeFileSync(configPath, JSON.stringify({
    agents: {
      standard: { type: 'claude', model: 'claude-sonnet-5' },
      complex: { type: 'claude', model: 'claude-sonnet-5' },
    },
    server: { port: 7399 },
  }), 'utf8');

  let exitCode = 0;
  let output = '';
  try {
    output = execFileSync('node', [cliPath, 'serve'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30_000,
      env: { ...process.env, MMA_CONFIG: configPath },
    });
  } catch (e) {
    exitCode = typeof e.status === 'number' ? e.status : 1;
    output = String(e.stdout ?? '') + String(e.stderr ?? '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (exitCode === 0) {
    throw new AbortError('required-tier', 'a config with no agents.main started the daemon',
      'agents.main is required — assertRunnable must reject a config that declares only standard and complex');
  }
  if (!output.includes('agents.main')) {
    throw new AbortError('required-tier', `startup failed but the message never names agents.main: ${output.trim().slice(0, 300)}`,
      'the error must name the missing tier so an upgrading user knows what to add');
  }
}

/**
 * Daemon-lifecycle release gate — `mma stop`, `mma restart`, `mma doctor`, the
 * pidfile, and the occupied-port error.
 *
 * WHY IT RESTARTS THE LIVE DAEMON. These commands ARE the upgrade path: a user
 * updating MMA stops and restarts this exact daemon, at this port, with this
 * config and this state directory. Proving them against a synthetic daemon on a
 * scratch port would test the code and skip the deployment. So the gate acts on
 * the real one.
 *
 * WHY IT IS SAFE HERE AND NOWHERE ELSE. It runs FIRST — before `bootId` is
 * captured and before a single scenario is dispatched. Nothing is in flight to
 * interrupt, and every later check measures the daemon this gate left running.
 * The same restart later in the run would interrupt concurrent scenarios and
 * invalidate the captured identity, which is why it lives here and not in a
 * scenario. Pass `--skip-lifecycle` to opt out.
 *
 * WHAT A FAILURE MEANS. The user cannot reliably update. That is a release
 * blocker, not a warning — so every assertion here aborts the run.
 */
async function daemonLifecycleGate() {
  const cliPath = join(REPO_ROOT, 'packages', 'server', 'dist', 'cli', 'index.js');
  if (!existsSync(cliPath)) {
    throw new AbortError('daemon-lifecycle', `no built CLI at ${cliPath}`, 'run `npm run build` before the smoke');
  }
  const run = (args) => {
    const res = execFileSyncSafe('node', [cliPath, ...args]);
    return { code: res.code, out: res.out };
  };
  const alive = async () => fetch(`${BASE_URL}/health`).then((r) => r.ok).catch(() => false);
  // Read the daemon's own configured stateDir rather than assuming the default:
  // an operator who moved it would otherwise see this gate assert against a
  // pidfile path the daemon never writes.
  const pidfile = join(resolveStateDir(), 'daemon.pid');

  // ── the documented surface exists ───────────────────────────────────────
  // A release that drops one of these silently breaks the upgrade instructions.
  const help = run(['--help']).out;
  for (const cmd of ['update', 'doctor', 'stop', 'restart']) {
    if (!new RegExp(`^\\s+${cmd}\\s`, 'm').test(help)) {
      throw new AbortError('daemon-lifecycle', `\`mma --help\` does not list '${cmd}'`,
        'every lifecycle command the README tells users to run must appear in the help output');
    }
  }

  // ── an occupied port explains itself ────────────────────────────────────
  // Only meaningful while a daemon holds the port, so it runs before the stop.
  if (await alive()) {
    const clash = run(['serve']);
    if (clash.code === 0) {
      throw new AbortError('daemon-lifecycle', 'a second daemon started while the port was already bound',
        'binding an occupied port must fail, not silently produce two daemons');
    }
    if (!/already in use/i.test(clash.out) || /at Server\.|node:net/.test(clash.out)) {
      throw new AbortError('daemon-lifecycle', `occupied-port output: ${clash.out.trim().slice(0, 200)}`,
        'expected a readable message naming the port and its owner, not a raw EADDRINUSE stack trace');
    }
  }

  // ── stop actually stops, and waits for it ───────────────────────────────
  const stopped = run(['stop']);
  if (stopped.code !== 0) {
    throw new AbortError('daemon-lifecycle', `\`mma stop\` exited ${stopped.code}: ${stopped.out.trim()}`,
      'stop must succeed against the running daemon');
  }
  if (await alive()) {
    throw new AbortError('daemon-lifecycle', '/health still answered after `mma stop` returned',
      'stop must not return until the process is gone — returning early is what made the old kill-then-start recipe lose the port race with its own replacement');
  }
  if (existsSync(pidfile)) {
    throw new AbortError('daemon-lifecycle', `${pidfile} survived a graceful stop`,
      'a stale record would make the next stop signal a pid the daemon no longer owns');
  }
  // Idempotent: a script that stops before installing must not fail because
  // there was nothing to stop.
  const again = run(['stop']);
  if (again.code !== 0) {
    throw new AbortError('daemon-lifecycle', `a second \`mma stop\` exited ${again.code}`,
      'stop is idempotent');
  }

  // ── restart brings the daemon back, and proves it ───────────────────────
  const restarted = run(['restart']);
  if (restarted.code !== 0) {
    throw new AbortError('daemon-lifecycle', `\`mma restart\` exited ${restarted.code}: ${restarted.out.trim()}`,
      'restart must start a daemon and wait until it answers /health — the rest of this smoke depends on it');
  }
  if (!(await alive())) {
    throw new AbortError('daemon-lifecycle', '`mma restart` reported success but nothing answers /health',
      'restart asserts health before returning, so success must mean the daemon is serving');
  }

  // ── the daemon recorded itself, and the record is true ──────────────────
  if (!existsSync(pidfile)) {
    throw new AbortError('daemon-lifecycle', `no pidfile at ${pidfile} after a successful start`,
      'the daemon must record itself so stop/restart/update find it by fact rather than by matching a process name');
  }
  const record = JSON.parse(readFileSync(pidfile, 'utf8'));
  for (const field of ['pid', 'port', 'bind', 'version', 'bootId', 'startedAt']) {
    if (!(field in record)) {
      throw new AbortError('daemon-lifecycle', `pidfile is missing '${field}'`,
        'an incomplete record must never be written — a partial read is treated as absent');
    }
  }
  const live = await fetch(`${BASE_URL}/status`, { headers: { Authorization: `Bearer ${readToken()}` } })
    .then((r) => r.ok ? r.json() : null).catch(() => null);
  if (!live || live.pid !== record.pid) {
    throw new AbortError('daemon-lifecycle', `pidfile pid=${record.pid} but /status reports pid=${live?.pid}`,
      'the record must describe the daemon that is actually serving');
  }

  // ── doctor reports every surface and gates on its findings ──────────────
  const doc = run(['doctor', '--offline', '--json']);
  let report;
  try { report = JSON.parse(doc.out); }
  catch {
    throw new AbortError('daemon-lifecycle', `\`mma doctor --json\` did not emit JSON: ${doc.out.slice(0, 200)}`,
      'doctor must stay machine-readable — it is what a user pastes into a bug report');
  }
  for (const key of ['package', 'daemon', 'plugin', 'skills', 'problems']) {
    if (!(key in report)) {
      throw new AbortError('daemon-lifecycle', `doctor JSON is missing '${key}'`,
        'doctor reports every surface an update can leave behind');
    }
  }
  if (report.daemon.running !== true || report.daemon.pid !== record.pid) {
    throw new AbortError('daemon-lifecycle',
      `doctor reports ${JSON.stringify(report.daemon)} but the serving pid is ${record.pid}`,
      'doctor must read the daemon it is pointed at, never infer it from the CLI it runs from');
  }
  if ((doc.code === 0) !== (report.problems.length === 0)) {
    throw new AbortError('daemon-lifecycle', `doctor exited ${doc.code} with ${report.problems.length} problem(s)`,
      'the exit code must track the findings so a script can gate on it');
  }
}

/**
 * Feature-coverage release gate — every shipped task type has a smoke scenario.
 *
 * WHY. `SCENARIOS` is hand-maintained. Adding a task type means touching the
 * type registry, a Zod variant, skill files and the capability row — and it is
 * entirely possible to do all of that, ship it, and never notice the release
 * smoke does not exercise it. The scheduler already refuses to drop a DECLARED
 * scenario; this refuses to drop a declared PRODUCT FEATURE, which is the gap
 * one level up.
 *
 * Read from the built registry rather than a list kept here, so the gate cannot
 * drift from the thing it is gating.
 */
async function taskTypeCoverageGate() {
  const coreDist = join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js');
  if (!existsSync(coreDist)) {
    throw new AbortError('feature-coverage', `no built core at ${coreDist}`, 'run `npm run build` before the smoke');
  }
  const { TASK_TYPES } = await import(pathToFileURL(coreDist).href);
  const { SCENARIOS } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'config.mjs')).href);

  const covered = new Set(SCENARIOS.map((s) => s.type));
  const missing = [...TASK_TYPES].filter((t) => !covered.has(t));
  if (missing.length > 0) {
    throw new AbortError('feature-coverage', `task type(s) with no smoke scenario: ${missing.join(', ')}`,
      'add a SCENARIOS entry in scripts/full-smoke/config.mjs, a buildRequest case in dispatch.mjs, and schedule the id in phase2Threads');
  }
}

/** The daemon's state directory, from its config, defaulting as the schema does. */
function resolveStateDir() {
  let configured = '~/.mma/state';
  try {
    configured = JSON.parse(readFileSync(join(HOME_MM, 'config.json'), 'utf8')).server?.stateDir ?? configured;
  } catch { /* no config, or no server block — the schema default applies */ }
  return configured.startsWith('~/') ? join(HOME_MM, '..', configured.slice(2)) : configured;
}

/** execFileSync that returns the exit code instead of throwing on non-zero —
 *  several assertions here are ABOUT the non-zero paths. */
function execFileSyncSafe(cmd, args) {
  try {
    return { code: 0, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

export class AbortError extends Error {
  constructor(gate, observed, remediation) {
    super(`[preflight ${gate}] observed: ${observed} | fix: ${remediation}`);
    this.gate = gate; this.observed = observed; this.remediation = remediation;
  }
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

function resolveDatabaseUrl() {
  if (process.env.SMOKE_DATABASE_URL) return process.env.SMOKE_DATABASE_URL;
  const envPath = join(process.cwd(), '..', 'multi-model-agent-telemetry-backend', '.env');
  if (!existsSync(envPath)) return null;
  const line = readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='));
  return line ? line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '') : null;
}

function dbHostApproved(url) {
  try { return APPROVED_DB_HOSTS.includes(new URL(url).hostname); } catch { return false; }
}

export async function preflight({ skipBackend = false, expectBranch = null, allowMismatch = false,
                                  skipLifecycle = false } = {}) {
  // FIRST, before anything else reads the daemon. This gate STOPS AND RESTARTS
  // the live daemon, so it must run before `bootId` and `serverVersion` are
  // captured below — every later check and every scenario is then measured
  // against the daemon this gate left running.
  if (!skipLifecycle) await daemonLifecycleGate();

  const health = await fetch(`${BASE_URL}/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) throw new AbortError('health', `GET /health -> ${health}`, 'start `pnpm run serve`');

  const token = readToken();
  const status = await fetch(`${BASE_URL}/status`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.ok ? r.json() : {}).catch(() => ({}));
  const serverVersion = status.version ?? 'unknown';
  const bootId = status.boot ?? status.bootId ?? 'unknown';
  const serverBranch = status.branch ?? null;
  if (expectBranch && serverBranch && serverBranch !== expectBranch && !allowMismatch) {
    throw new AbortError('checkout-fingerprint', `server branch=${serverBranch} expected=${expectBranch}`,
      'pass --allow-mismatch or restart the server on the expected checkout');
  }

  // Backlog F1: /status must expose skill-manifest fields derived from the REAL
  // install-manifest.json (skillVersion string|null, skillCompatible bool|null,
  // consistent nullability) — not the old dead-path always-null values.
  {
    const sv = status.skillVersion;
    const sc = status.skillCompatible;
    const svOk = sv === null || typeof sv === 'string';
    const scOk = sc === null || typeof sc === 'boolean';
    const consistent = sv === null ? sc === null : true;
    if (!('skillVersion' in status) || !svOk || !scOk || !consistent) {
      throw new AbortError('status-skill-fields',
        `skillVersion=${JSON.stringify(sv)} skillCompatible=${JSON.stringify(sc)}`,
        'GET /status must derive skillVersion/skillCompatible from install-manifest.json (backlog F1)');
    }
  }

  // Backlog F8: a 405 response MUST advertise the supported methods in an Allow
  // header (RFC 7231 §6.5.5), not only in the JSON body.
  {
    const res = await fetch(`${BASE_URL}/task`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    const allow = res ? res.headers.get('allow') : null;
    if (!res || res.status !== 405 || allow !== 'POST') {
      throw new AbortError('405-allow-header',
        `DELETE /task -> ${res ? res.status : 'no-response'} allow=${allow}`,
        'a 405 must set the Allow header to the supported methods (backlog F8)');
    }
  }

  if (!existsSync(IDENTITY_FILE)) throw new AbortError('install-id', `missing ${IDENTITY_FILE}`,
    'run the server once so it generates the telemetry identity (identity.json)');
  const installId = JSON.parse(readFileSync(IDENTITY_FILE, 'utf8')).installId;
  if (!installId) throw new AbortError('install-id', `${IDENTITY_FILE} has no installId`,
    'the identity file is malformed; delete it and restart the server to regenerate');

  // Diagnostics gate: today's JSONL must exist (proves diagnostics.log is on).
  const diagFile = join(DIAG_DIR, `mma-${todayUtc()}.jsonl`);
  if (!existsSync(diagFile)) throw new AbortError('diagnostics', `no ${diagFile}`,
    'set diagnostics.log: true in config and restart the server');

  // Skill-surface release gate (design→explore/brainstorm split intact).
  skillSurfaceGate();

  // Plugin-surface release gate: the committed marketplace artifact is fresh,
  // correctly namespaced, and carries no secret.
  pluginSurfaceGate();

  // Agent Plugins release gate: the emitted AP package is spec-shaped, shares one
  // payload with the Claude Code target, declares a working MCP entry, and ships
  // no secret.
  agentPluginSurfaceGate();

  // Packaged-layout release gate: the shipped assets are findable when the code
  // runs from an installed path rather than from this monorepo.
  packagedLayoutGate();

  // MCP-only release gate: no shipped instruction teaches the HTTP route, and
  // every skill emits the one actionable unavailable-MCP command.
  mcpOnlySurfaceGate();

  // Canonical client roster: the live inventory matches CLIENT_IDS exactly.
  await clientRosterGate(token);

  // Required tiers: a config without agents.main refuses to start, by name.
  requiredTierGate();

  // Feature coverage: every shipped task type has a scenario in this smoke.
  await taskTypeCoverageGate();

  const ctx = { token, serverVersion, bootId, serverBranch, installId,
                runStartTs: new Date().toISOString(), databaseUrl: null,
                backend: !skipBackend, dbApproved: false, queueFile: QUEUE_FILE, diagFile };

  if (!skipBackend) {
    if (!existsSync(QUEUE_FILE)) throw new AbortError('telemetry', `no ${QUEUE_FILE}`,
      'enable telemetry (telemetry.enabled: true) and restart the server, or use --skip-backend');
    const dbUrl = resolveDatabaseUrl();
    if (!dbUrl) throw new AbortError('database-url', 'DATABASE_URL unresolved',
      'set SMOKE_DATABASE_URL or place the backend repo beside this one, or use --skip-backend');
    try { execFileSync('psql', [dbUrl, '-c', 'select 1'], { stdio: 'pipe' }); }
    catch (e) { throw new AbortError('db-connect', String(e.stderr || e.message || e), 'check DATABASE_URL + that Postgres is up'); }
    ctx.databaseUrl = dbUrl;
    // Approved-env gates DELETION, not the run. A reachable non-local DB (e.g. a
    // remote/shared backend) is read for verification, but teardown will NOT
    // delete from it — auto-deleting from a non-local backend is unsafe.
    ctx.dbApproved = dbHostApproved(dbUrl);
    if (!ctx.dbApproved) {
      const host = (() => { try { return new URL(dbUrl).hostname; } catch { return '?'; } })();
      console.error(`[preflight] WARNING: DB host ${host} is not local/approved — backend verification will READ only; teardown will NOT delete rows (clean up manually if desired).`);
    }
  }
  return ctx;
}
