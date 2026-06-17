import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { BASE_URL, INSTALL_ID_FILE, APPROVED_DB_HOSTS, QUEUE_FILE, DIAG_DIR } from './config.mjs';
import { readToken } from './http.mjs';

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
