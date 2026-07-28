import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, IDENTITY_FILE, APPROVED_DB_HOSTS, QUEUE_FILE, DIAG_DIR } from './config.mjs';
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
  // The per-client installers legitimately substitute it into skill text; the
  // plugin must not, because it is published.
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
        'the plugin is distributable — never pass authToken to inlineIncludes when generating it');
    }
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

export async function preflight({ skipBackend = false, expectBranch = null, allowMismatch = false } = {}) {
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
