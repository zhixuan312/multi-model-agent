import { resolve } from 'node:path';
import { CorpusIndex, FileCorpusAdapter } from '@zhixuan92/multi-model-agent-core';
import type { FallbackSweepState, SymbolRecord } from '@zhixuan92/multi-model-agent-core';
import { PreprocessFailure } from './types.js';
import type { Preprocessor } from './types.js';

/** Deterministic candidate cap — mirrors journal recall's "about 20" bound. */
const CANDIDATE_CAP = 20;
/** Approximate serialized-token budget for `candidates` + `folderMap` combined. */
const TOKEN_BUDGET = 4000;
/** Snippet length cap, in characters, after whitespace collapse. */
const SNIPPET_MAX_CHARS = 240;
/** Bounded retry for transient SQLite write-lock contention (see {@link loadIndexState}). */
const MAX_INDEX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 50;

interface InvestigateCandidate {
  path: string;
  name: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

interface FolderSummary {
  folder: string;
  fileCount: number;
  symbolCount: number;
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return Array.from(new Set(matches.filter((token) => token.length > 1)));
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Cheap lexical relevance score: name matches count more than body matches,
 * because a symbol whose NAME contains a query token is more likely to be
 * exactly what the prompt is asking about than one that merely mentions the
 * token somewhere in its body.
 */
function scoreSymbol(tokens: string[], symbol: SymbolRecord): number {
  const name = symbol.name.toLowerCase();
  const body = symbol.body.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 3;
    if (body.includes(token)) score += 1;
  }
  return score;
}

/** Parent directory of a corpus-relative path, `.` for a root-level file. */
function parentFolder(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? '.' : filePath.slice(0, index);
}

/**
 * Conservative serialized-context estimate. Compact JSON often contains very
 * little whitespace, so counting whitespace-separated words would treat an
 * arbitrarily large folder map as a single token. Four characters per token
 * is deliberately simple but puts a real, deterministic bound on the payload.
 */
function estimateTokenCount(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for SQLite's transient write-lock-contention errors, which a short retry resolves; false for anything else (a real defect must not be retried away). */
function isTransientLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

type IndexPhase = 'open' | 'sync' | 'search';

class IndexPhaseError extends Error {
  constructor(
    public readonly phase: IndexPhase,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

const PHASE_FAILURE_CODE: Record<IndexPhase, string> = {
  open: 'investigate_index_open_failed',
  sync: 'investigate_index_sync_failed',
  search: 'investigate_index_search_failed',
};
const PHASE_FAILURE_VERB: Record<IndexPhase, string> = {
  open: 'open',
  sync: 'refresh',
  search: 'search',
};

/**
 * Serializes investigate preprocessing PER REPOSITORY ROOT within this
 * process. The index is one shared SQLite file living at the corpus root
 * (see {@link loadIndexState}'s doc). Two investigate calls against the SAME
 * project landing in this process at once would otherwise open two writers
 * against that one file concurrently — observed in practice as a hard
 * "database is locked" error during first-time population, not merely a
 * bounded `busy_timeout` wait. Queuing same-root calls removes that race for
 * the common case (one server process); {@link isTransientLockError}'s retry
 * below is the remaining defense for genuine cross-process concurrency (e.g.
 * two separate `mma serve` processes pointed at the same repository).
 */
const rootQueues = new Map<string, Promise<unknown>>();

function withRootQueue<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previous = rootQueues.get(root) ?? Promise.resolve();
  const next = previous.then(run, run);
  // Chain future callers off a NEVER-REJECTING promise so one failed call
  // doesn't poison the queue for the next caller; each caller still observes
  // its own `next`'s real outcome via the returned promise.
  const settled = next.catch(() => undefined);
  rootQueues.set(root, settled);
  // Delete the entry once it settles, so a root that stops receiving calls
  // does not hold a `rootQueues` entry (and its resolved promise) forever —
  // this map has no other eviction path. Only delete when this call's
  // `settled` marker is STILL the tail of the queue for `root`: a later
  // caller may already have chained off it and replaced the map entry with
  // its own `settled` marker, which must be left alone (deleting it here
  // would drop a still-pending caller's serialization).
  void settled.finally(() => {
    if (rootQueues.get(root) === settled) rootQueues.delete(root);
  });
  return next;
}

/**
 * Process-wide, canonical-root-keyed non-git fallback-sweep throttle state
 * (see {@link CorpusIndex}'s `FallbackSweepState`). This preprocessor opens a
 * NEW `CorpusIndex` per request and closes it (see {@link attemptLoadIndexState}),
 * so the throttle state must live here rather than on the `CorpusIndex`
 * instance, or it resets — and so never actually throttles — on every
 * request. Keyed by `resolve(cwd)` so equivalent (non-symlink) path spellings
 * of the same root share one throttle.
 */
const sweepStateByRoot = new Map<string, FallbackSweepState>();

/**
 * Bounded-eviction cap for {@link sweepStateByRoot} — the same unbounded-map
 * defect {@link rootQueues} was fixed for, reintroduced here because this
 * map has no natural "settle and delete" point of its own: a sweep-state
 * entry is a long-lived throttle counter meant to persist ACROSS calls for
 * the same root, not a per-call promise that resolves and can be cleaned up.
 * Instead, bound the map with simple LRU eviction: the least-recently-used
 * root's entry is dropped once the map would otherwise exceed this size, so
 * a process that serves many distinct repository roots over its lifetime
 * cannot grow this map forever.
 */
const MAX_TRACKED_SWEEP_ROOTS = 500;

function sweepStateFor(cwd: string): FallbackSweepState {
  const canonicalRoot = resolve(cwd);
  const existing = sweepStateByRoot.get(canonicalRoot);
  if (existing) {
    // Bump recency: `Map` iteration order is insertion order, so a
    // delete-then-set moves this entry to the end — "most recently used" for
    // the eviction check below.
    sweepStateByRoot.delete(canonicalRoot);
    sweepStateByRoot.set(canonicalRoot, existing);
    return existing;
  }
  const state: FallbackSweepState = { lastFallbackSweepAt: null, fallbackSweepCount: 0 };
  sweepStateByRoot.set(canonicalRoot, state);
  if (sweepStateByRoot.size > MAX_TRACKED_SWEEP_ROOTS) {
    const oldestRoot = sweepStateByRoot.keys().next().value;
    if (oldestRoot !== undefined) sweepStateByRoot.delete(oldestRoot);
  }
  return state;
}

/** One open→ensureHealthy→ensureFresh→allSymbols→allFiles→close attempt, tagged with the phase that failed (if any) so the caller can classify + retry. */
async function attemptLoadIndexState(
  cwd: string,
): Promise<{ allSymbols: SymbolRecord[]; allFiles: Array<{ filePath: string }> }> {
  const adapter = new FileCorpusAdapter({ root: cwd });
  let index: CorpusIndex;
  try {
    index = await CorpusIndex.open({ root: cwd, adapter, sweepState: sweepStateFor(cwd) });
  } catch (error) {
    throw new IndexPhaseError('open', error);
  }
  try {
    try {
      // Schema health first (rebuilds a missing/stale database), then
      // freshness (sublinear git-status sync, or throttled stat-sweep
      // fallback for a non-git root) — same ordering journal recall uses.
      await index.ensureHealthy();
      await index.ensureFresh();
    } catch (error) {
      throw new IndexPhaseError('sync', error);
    }
    try {
      const allSymbols = await index.allSymbols();
      const allFiles = await index.allFiles();
      return { allSymbols, allFiles };
    } catch (error) {
      throw new IndexPhaseError('search', error);
    }
  } finally {
    // Close the WAL connection so no lock leaks per request.
    index.close();
  }
}

/**
 * Open the repository-wide symbol index, refresh it, and read back every
 * indexed symbol/file — with bounded retry against transient write-lock
 * contention. See {@link withRootQueue} and {@link isTransientLockError} for
 * why retry is needed at all: this preprocessor is the first consumer that
 * opens the `SymbolCorpusAdapter` index against a large, actively-shared
 * corpus (the whole repository) rather than the small `.mma/journal/` tree.
 */
async function loadIndexState(
  cwd: string,
): Promise<{ allSymbols: SymbolRecord[]; allFiles: Array<{ filePath: string }> }> {
  let lastError: IndexPhaseError | undefined;
  for (let attempt = 1; attempt <= MAX_INDEX_ATTEMPTS; attempt++) {
    try {
      return await attemptLoadIndexState(cwd);
    } catch (error) {
      if (!(error instanceof IndexPhaseError)) throw error;
      lastError = error;
      if (attempt < MAX_INDEX_ATTEMPTS && isTransientLockError(error.cause instanceof Error ? error.cause : error)) {
        await delay(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      break;
    }
  }
  const phase = lastError!.phase;
  throw new PreprocessFailure(
    PHASE_FAILURE_CODE[phase],
    `Failed to ${PHASE_FAILURE_VERB[phase]} the repository index: ${lastError!.message}`,
  );
}

/**
 * investigate pre-processing: search the fresh repository symbol index once,
 * before the worker starts, and inject a bounded candidate list plus a
 * folder-level map so the worker starts with real leads instead of scanning
 * the repository cold.
 *
 * Mirrors the open/search/write-payload/`finally` close lifecycle of
 * journal-recall.ts, against the repository file index instead of the
 * journal. The index root is the repository root itself (`cwd`) — the same
 * convention `FileCorpusAdapter`'s own tests use — because `index.db` lives
 * alongside the code it indexes and the adapter already filters its own
 * derived-database files out of `listFiles()`.
 *
 * This search runs ONCE, before the worker's first turn. It cannot help the
 * worker discover a symbol introduced mid-investigation (e.g. one only found
 * by following an import chain) — the worker still has full grep/read tools
 * for that; see the skill guidance this preprocessor's candidates feed into.
 */
export const investigatePreprocessor: Preprocessor = async ({ cwd, payload }) => {
  const invPayload = payload as { prompt: string };

  const { allSymbols, allFiles } = await withRootQueue(cwd, () => loadIndexState(cwd));

  // Folder-level map: aggregated over the WHOLE indexed corpus (every
  // file/symbol the engine knows about), never a full file list. A full
  // file list for this repository alone runs to roughly 5,500 tokens and
  // only grows with the repo; a folder map with a count per directory stays
  // small and still tells the worker where the weight of the code lives.
  const folderStats = new Map<string, { fileCount: number; symbolCount: number }>();
  for (const file of allFiles) {
    const folder = parentFolder(file.filePath);
    const entry = folderStats.get(folder) ?? { fileCount: 0, symbolCount: 0 };
    entry.fileCount += 1;
    folderStats.set(folder, entry);
  }
  for (const symbol of allSymbols) {
    const folder = parentFolder(symbol.filePath);
    const entry = folderStats.get(folder) ?? { fileCount: 0, symbolCount: 0 };
    entry.symbolCount += 1;
    folderStats.set(folder, entry);
  }
  let folderMap: FolderSummary[] = Array.from(folderStats.entries())
    .map(([folder, stats]) => ({ folder, ...stats }))
    .sort((a, b) => {
      if (b.symbolCount !== a.symbolCount) return b.symbolCount - a.symbolCount;
      if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount;
      return a.folder.localeCompare(b.folder);
    });

  // Candidates: rank every indexed symbol against the prompt's tokens, best
  // first; deterministic tie-break by (path, startLine) so repeated runs
  // against an unchanged index produce the same order.
  const tokens = tokenize(invPayload.prompt ?? '');
  const ranked = allSymbols
    .map((symbol) => ({ symbol, score: scoreSymbol(tokens, symbol) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.symbol.filePath !== b.symbol.filePath) return a.symbol.filePath.localeCompare(b.symbol.filePath);
      return a.symbol.startLine - b.symbol.startLine;
    });

  let candidates: InvestigateCandidate[] = ranked.slice(0, CANDIDATE_CAP).map(({ symbol }) => ({
    path: symbol.filePath,
    name: symbol.name,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    snippet: collapseWhitespace(symbol.body).slice(0, SNIPPET_MAX_CHARS),
  }));

  // Deterministic budget guard: preserve the best candidate leads first,
  // trimming the least information-dense folders before the lowest-ranked
  // candidate. This means an unusually deep repository cannot spend the
  // whole prompt allowance on the folder map alone. Candidate truncation is
  // still deterministic (the list is already ranked best-first).
  while (folderMap.length > 0 && estimateTokenCount({ candidates, folderMap }) > TOKEN_BUDGET) {
    folderMap = folderMap.slice(0, -1);
  }
  while (candidates.length > 0 && estimateTokenCount({ candidates, folderMap }) > TOKEN_BUDGET) {
    candidates = candidates.slice(0, -1);
  }

  (payload as Record<string, unknown>).candidates = candidates;
  (payload as Record<string, unknown>).folderMap = folderMap;

  return {};
};
