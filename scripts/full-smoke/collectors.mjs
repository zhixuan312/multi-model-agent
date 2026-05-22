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

// ③ queue: wire records since `prevCount` lines (append-window correlation —
// the wire record carries NO batchId, only eventId, so per-dispatch isolation
// uses the append window on an idle server; the flusher may drain mid-run, so
// this is best-effort and ④ is the durable truth).
export function queueLineCount() {
  if (!existsSync(QUEUE_FILE)) return 0;
  return readFileSync(QUEUE_FILE, 'utf8').split('\n').filter(Boolean).length;
}
export function collectQueue(prevCount = 0) {
  if (!existsSync(QUEUE_FILE)) return { records: [], eventIds: [] };
  const all = readFileSync(QUEUE_FILE, 'utf8').split('\n').filter(Boolean);
  // If the file shrank (flush rewrote it), fall back to the whole file.
  const slice = all.length >= prevCount ? all.slice(prevCount) : all;
  const recs = slice.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // Each queue line is a BATCH WRAPPER: { events:[{eventId,...}], installId, schemaVersion, ... }.
  const eventIds = recs.flatMap((r) =>
    Array.isArray(r.events) ? r.events.map((e) => e.eventId).filter(Boolean)
      : (r.eventId ? [r.eventId] : []));
  return { records: recs, eventIds };
}

// ④ backend: rows in events_raw correlated by event_id (= the queue record's
// eventId). Unambiguous (no install_id-source guessing). NOTE: the server's
// flusher uploads only every 5 minutes, so without --wait-flush these rows
// won't have landed yet — that's why the run-level check is queue-first.
export function collectBackend(databaseUrl, eventIds) {
  const ids = (eventIds || []).filter((e) => /^[0-9a-f-]{36}$/i.test(e));
  if (!databaseUrl || !ids.length) return { matched: [], queried: ids.length };
  const cols = EVENTS_RAW_COLUMNS.join(', ');
  const inList = ids.map((e) => `'${e}'`).join(',');
  let rows = '';
  try { rows = execFileSync('psql', [databaseUrl, '-t', '-A', '-c',
    `SELECT ${cols}, event::text FROM events_raw WHERE event_id IN (${inList})`], { encoding: 'utf8' }).trim(); }
  catch { return { matched: [], queried: ids.length }; }
  const matched = rows ? rows.split('\n').filter(Boolean).map((line) => {
    const parts = line.split('|');
    let event = {}; try { event = JSON.parse(parts.slice(EVENTS_RAW_COLUMNS.length).join('|')); } catch { /* */ }
    const row = {}; EVENTS_RAW_COLUMNS.forEach((c, i) => { row[c] = parts[i]; });
    row.event = event; return row;
  }) : [];
  return { matched, queried: ids.length };
}
