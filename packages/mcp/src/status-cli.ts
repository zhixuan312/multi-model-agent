import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { discoverConfig } from './cli.js';

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export async function runStatusCli(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const config = await discoverConfig();
  const { bind, port, auth } = config.transport.http;
  const host = bind === '0.0.0.0' ? '127.0.0.1' : bind;
  const urlHost = host.includes(':') ? `[${host}]` : host;
  const url = `http://${urlHost}:${port}/status`;
  const headers: Record<string, string> = {};
  if (auth.enabled) {
    const tokenPath = expandHome(auth.tokenPath);
    if (!fs.existsSync(tokenPath)) {
      console.error(`error: auth is enabled but token file not found at ${tokenPath}`);
      process.exit(2);
    }
    headers['Authorization'] = `Bearer ${fs.readFileSync(tokenPath, 'utf8').trim()}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    console.error(`error: could not reach daemon at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`error: /status returned ${res.status} ${res.statusText}`);
    process.exit(2);
  }
  const body = await res.json() as any;

  if (jsonMode) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const baseUrl = url.replace('/status', '');
  console.log(`mmagent ${body.version}  ·  pid ${body.pid}  ·  uptime ${formatDuration(body.uptimeMs)}  ·  ${baseUrl}`);
  console.log(`Projects (${body.projects.length}):`);
  for (const p of body.projects) {
    const idle = Date.now() - Date.parse(p.lastSeenAt);
    console.log(`  ${p.cwd}    ${p.activeSessions} sess   ${p.batchCacheSize} batches   last seen ${formatDuration(idle)} ago`);
  }
  if (body.activeRequests.length > 0) {
    console.log(`\nActive requests (${body.activeRequests.length}):`);
    for (const r of body.activeRequests) {
      const age = Date.now() - Date.parse(r.startedAt);
      console.log(`  ${r.sessionId}  ${r.cwd}  ${r.tool}   ${formatDuration(age)}   ${r.lastHeadline ?? ''}`);
    }
  }
}
