import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, INSTALL_ID_FILE, APPROVED_DB_HOSTS, QUEUE_FILE, DIAG_DIR } from './config.mjs';
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
  for (const marker of ['.mma/explorations/', '## Background', '## Current State', '## Rough Direction', 'in ONE message']) {
    if (!explore.includes(marker)) {
      throw new AbortError('skill-surface', `mma-explore SKILL.md missing marker: ${marker}`,
        'mma-explore must braindump → fan out → write exploration.md (Background · Current State · Rough Direction)');
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

  if (!existsSync(INSTALL_ID_FILE)) throw new AbortError('install-id', `missing ${INSTALL_ID_FILE}`,
    'run the server once so it generates the install id');
  const installId = readFileSync(INSTALL_ID_FILE, 'utf8').trim();

  // Diagnostics gate: today's JSONL must exist (proves diagnostics.log is on).
  const diagFile = join(DIAG_DIR, `mma-${todayUtc()}.jsonl`);
  if (!existsSync(diagFile)) throw new AbortError('diagnostics', `no ${diagFile}`,
    'set diagnostics.log: true in config and restart the server');

  // Skill-surface release gate (design→explore/brainstorm split intact).
  skillSurfaceGate();

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
