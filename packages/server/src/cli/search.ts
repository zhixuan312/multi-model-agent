/**
 * `mma search` — answer "where is this in the code?" in ONE call.
 *
 * Measured motivation: across 285 real tasks, 84% of every worker's tool calls
 * were file search or file read, and the dominant pattern was repetition —
 * search, search again, read, read again. On the Codex side one lookup
 * routinely cost three commands: `rg` to find it, `sed` to slice the file, `nl`
 * to get line numbers.
 *
 * Two things make that expensive, and only one of them is time. Every tool call
 * is a turn, and every turn resends the whole transcript — so a raw `rg` that
 * dumps hundreds of unranked lines costs context on that turn AND on every turn
 * after it. This command is therefore optimized for CONTEXT DENSITY first:
 * ranked hits, capped count, capped lines per hit, line numbers already
 * attached, and a hard total budget. The aim is that a worker needs no
 * follow-up read at all.
 *
 * It runs over the same derived index the `investigate` preprocessor uses, via
 * the same locator, so the CLI and the route never disagree or build twice.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CorpusIndex, FileCorpusAdapter } from '@zhixuan92/multi-model-agent-core';
import { corpusIndexDbPath, tokenize } from '../application/corpus-index-locator.js';

/** Hits returned by default. Enough to choose from, small enough to stay dense. */
const DEFAULT_LIMIT = 10;
/** Body lines shown per hit before truncation. */
const DEFAULT_LINES = 12;
/** Hard ceiling on printed characters, so one call can never flood a transcript. */
const TOTAL_CHAR_BUDGET = 12_000;

export interface SearchOptions {
  /** Free-text question. Tokenized the same way the investigate route tokenizes it. */
  query: string;
  /** Repository root to search. */
  cwd: string;
  /** MMA state directory, which holds the derived index. */
  stateDir: string;
  limit?: number;
  /** Body lines shown per hit. */
  lines?: number;
  /** Emit machine-readable JSON instead of the dense human/worker format. */
  json?: boolean;
  stdout: (line: string) => boolean;
  stderr?: (line: string) => boolean;
}

interface Hit {
  path: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  body: string;
}

/** Body text to numbered lines, truncated to `maxLines` with an explicit marker. */
function numbered(body: string, startLine: number, maxLines: number): string[] {
  const all = body.split('\n');
  const shown = all.slice(0, maxLines);
  const width = String(startLine + shown.length - 1).length;
  const out = shown.map((text, i) => `  ${String(startLine + i).padStart(width)} | ${text}`);
  if (all.length > shown.length) {
    out.push(`  ${' '.repeat(width)} | … ${all.length - shown.length} more lines (read the file for the rest)`);
  }
  return out;
}

export async function runSearch(opts: SearchOptions): Promise<number> {
  const root = resolve(opts.cwd);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const lines = opts.lines && opts.lines > 0 ? opts.lines : DEFAULT_LINES;
  const err = opts.stderr ?? (() => true);

  const tokens = tokenize(opts.query);
  if (tokens.length === 0) {
    err('mma search: query has no searchable tokens (single characters are ignored)\n');
    return 1;
  }

  const dbPath = await corpusIndexDbPath(root, opts.stateDir);
  if (!existsSync(dbPath)) {
    err(`mma search: no index yet for ${root}\nOne is built automatically the first time an investigate task runs against this directory.\n`);
    return 1;
  }

  // READ-ONLY on purpose. This command runs INSIDE a worker sandbox, which for
  // codex is an OS-level `-s read-only` jail. A normal SQLite open creates
  // `-wal`/`-shm` sidecars and fails there with "attempt to write a readonly
  // database" — that is exactly what broke the first version of this command.
  //
  // Read-only also means this process must NOT call ensureHealthy()/
  // ensureFresh(); both write. That is the right split: the daemon's
  // investigate preprocessor refreshes the index before the worker starts, so
  // the worker only ever reads an already-current index.
  const index = await CorpusIndex.open({ root, adapter: new FileCorpusAdapter({ root }), dbPath, readOnly: true });
  let hits: Hit[];
  try {
    const ranked = await index.rankedSymbolsByTokens(tokens, limit);
    const bodyById = new Map((await index.symbolsByIds(ranked.map((s) => s.id))).map((s) => [s.id, s.body]));
    hits = ranked.map((s) => ({
      path: s.filePath,
      name: s.name,
      kind: s.kind,
      startLine: s.startLine,
      endLine: s.endLine,
      body: bodyById.get(s.id) ?? '',
    }));
  } finally {
    index.close();
  }

  if (opts.json) {
    opts.stdout(`${JSON.stringify({ query: opts.query, tokens, hits }, null, 2)}\n`);
    return 0;
  }

  if (hits.length === 0) {
    opts.stdout(`No symbol matches for: ${tokens.join(' ')}\n`);
    return 0;
  }

  let spent = 0;
  let printed = 0;
  for (const hit of hits) {
    const header = `${hit.path}:${hit.startLine}-${hit.endLine}  ${hit.name} (${hit.kind})`;
    const block = [header, ...numbered(hit.body, hit.startLine, lines), ''].join('\n');
    if (spent + block.length > TOTAL_CHAR_BUDGET && printed > 0) {
      opts.stdout(`… ${hits.length - printed} more matches omitted to stay within the output budget; narrow the query or raise --limit\n`);
      break;
    }
    opts.stdout(`${block}\n`);
    spent += block.length;
    printed += 1;
  }
  return 0;
}
