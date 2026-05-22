import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { QUEUE_FILE, DIAG_DIR, EVENTS_RAW_COLUMNS, POLL } from './config.mjs';

// ① response: the terminal envelope (already polled)
export function collectResponse(envelope) {
  return {
    error: envelope.error,
    structuredReport: envelope.structuredReport,
    results: Array.isArray(envelope.results) ? envelope.results : [],
    costSummary: envelope.costSummary,
  };
}

function diagLines() {
  const days = [0, 1].map((d) => {
    const t = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    return join(DIAG_DIR, `mmagent-${t}.jsonl`);
  });
  let lines = [];
  for (const f of days) if (existsSync(f)) lines = lines.concat(readFileSync(f, 'utf8').split('\n').filter(Boolean));
  return lines;
}

// ② diagnostics JSONL for a batchId
export function collectDiagnostics(batchId) {
  const events = diagLines()
    .filter((l) => l.includes(batchId))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const completed = events.find((e) => e.kind === 'batch_completed' || e.kind === 'batch_failed');
  return { events, dispatchMode: completed?.fields?.dispatch_mode ?? null,
           taskCount: completed?.fields?.task_count ?? null,
           terminalKind: completed?.kind ?? null };
}

// ③ queue: wire records for a batchId (snapshot now — drains on flush)
export function collectQueue(batchId) {
  if (!existsSync(QUEUE_FILE)) return { records: [], eventIds: [] };
  const recs = readFileSync(QUEUE_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((r) => JSON.stringify(r).includes(batchId));
  return { records: recs, eventIds: recs.map((r) => r.eventId).filter(Boolean) };
}

// ④ backend: per-event rows (event JSONB parsed) + completeness count by install+window
export async function collectBackend(databaseUrl, eventIds, installId, runStartTs) {
  if (!databaseUrl) return { byEvent: [], windowCount: null };
  const q = (sql) => execFileSync('psql', [databaseUrl, '-t', '-A', '-c', sql], { encoding: 'utf8' }).trim();
  const windowSql = `SELECT count(*) FROM events_raw WHERE install_id='${installId}' AND received_at >= '${runStartTs}'`;
  const start = Date.now(); let windowCount = 0;
  for (;;) {
    try { windowCount = parseInt(q(windowSql) || '0', 10); } catch { windowCount = 0; }
    if (windowCount > 0 || Date.now() - start >= POLL.backendMaxMs) break;
    await new Promise((r) => setTimeout(r, POLL.backendEveryMs));
  }
  let byEvent = [];
  if (eventIds.length) {
    const inList = eventIds.filter((e) => /^[0-9a-f-]{36}$/i.test(e)).map((e) => `'${e}'`).join(',');
    if (inList) {
      const cols = EVENTS_RAW_COLUMNS.join(', ');
      const rows = q(`SELECT ${cols}, event::text FROM events_raw WHERE event_id IN (${inList})`);
      byEvent = rows ? rows.split('\n').filter(Boolean).map((line) => {
        const parts = line.split('|');
        const evJson = parts.slice(EVENTS_RAW_COLUMNS.length).join('|');
        let event = {}; try { event = JSON.parse(evJson); } catch { /* */ }
        const row = {}; EVENTS_RAW_COLUMNS.forEach((c, i) => { row[c] = parts[i]; });
        row.event = event; return row;
      }) : [];
    }
  }
  return { byEvent, windowCount };
}
