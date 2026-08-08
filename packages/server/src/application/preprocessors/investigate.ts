import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { CorpusIndex, FileCorpusAdapter } from '@zhixuan92/multi-model-agent-core';
import type { FallbackSweepState } from '@zhixuan92/multi-model-agent-core';
import { expandHome } from '../../expand-home.js';
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

/**
 * Where THIS repository's derived code-corpus index lives — inside MMA's own
 * state directory, keyed by the repository's REAL (symlink- and
 * relative/trailing-slash-spelling-resolved) path, never inside the
 * repository itself. A derived cache must never appear in a source tree the
 * caller does not own: `investigate` may be pointed at any repository, not
 * only this one, and that repository's own `.gitignore` has no reason to
 * know about MMA's cache files.
 *
 * `realpath(cwd)` first, so `/repo`, `/repo/`, a relative spelling, and a
 * symlink to `/repo` all hash to the SAME path and so share one index file.
 * The readable repository basename is prefixed to the hash purely so the
 * `corpus-index/` directory stays debuggable by eye; the hash is what
 * actually guarantees uniqueness.
 */
async function corpusIndexDbPath(cwd: string, stateDir: string): Promise<string> {
  const realRoot = await realpath(cwd);
  const hash = createHash('sha256').update(realRoot).digest('hex').slice(0, 16);
  const dir = join(expandHome(stateDir), 'corpus-index');
  await mkdir(dir, { recursive: true });
  return join(dir, `${basename(realRoot)}-${hash}.db`);
}

/**
 * Let SQLite rank every indexed symbol and return only the top
 * {@link CANDIDATE_CAP} metadata rows, then materialize `body` text ONLY for
 * those survivors — never for the whole corpus. Must run while `index` is
 * still open.
 */
async function buildCandidates(index: CorpusIndex, prompt: string): Promise<InvestigateCandidate[]> {
  const tokens = tokenize(prompt ?? '');
  const ranked = await index.rankedSymbolsByTokens(tokens, CANDIDATE_CAP);

  const bodyById = new Map((await index.symbolsByIds(ranked.map((symbol) => symbol.id))).map((s) => [s.id, s.body]));

  return ranked.map((symbol) => ({
    path: symbol.filePath,
    name: symbol.name,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    snippet: collapseWhitespace(bodyById.get(symbol.id) ?? '').slice(0, SNIPPET_MAX_CHARS),
  }));
}

/** One open→ensureHealthy→ensureFresh→rank→materialize-survivors→close attempt, tagged with the phase that failed (if any) so the caller can classify + retry. */
async function attemptLoadIndexState(
  cwd: string,
  dbPath: string,
  prompt: string,
): Promise<{ candidates: InvestigateCandidate[]; folderMap: FolderSummary[] }> {
  const adapter = new FileCorpusAdapter({ root: cwd });
  let index: CorpusIndex;
  try {
    index = await CorpusIndex.open({ root: cwd, adapter, dbPath, sweepState: sweepStateFor(cwd) });
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
      // Folder counts and candidate ranking both execute in SQLite. The only
      // symbol bodies materialized in JS are the capped candidate survivors.
      const folderMap = index.folderSummaries();
      const candidates = await buildCandidates(index, prompt);
      return { candidates, folderMap };
    } catch (error) {
      throw new IndexPhaseError('search', error);
    }
  } finally {
    // Close the WAL connection so no lock leaks per request.
    index.close();
  }
}

/**
 * Open the repository-wide symbol index, refresh it, and rank/materialize the
 * bounded candidate list plus folder map — with bounded retry against
 * transient write-lock contention. See {@link withRootQueue} and
 * {@link isTransientLockError} for why retry is needed at all: this
 * preprocessor is the first consumer that opens the `SymbolCorpusAdapter`
 * index against a large, actively-shared corpus (the whole repository)
 * rather than the small `.mma/journal/` tree.
 */
async function loadIndexState(
  cwd: string,
  dbPath: string,
  prompt: string,
): Promise<{ candidates: InvestigateCandidate[]; folderMap: FolderSummary[] }> {
  let lastError: IndexPhaseError | undefined;
  for (let attempt = 1; attempt <= MAX_INDEX_ATTEMPTS; attempt++) {
    try {
      return await attemptLoadIndexState(cwd, dbPath, prompt);
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
 * journal. The corpus root walked/read is the repository root itself
 * (`cwd`), but the derived `index.db` itself lives OUTSIDE that root, under
 * MMA's own state directory (see {@link corpusIndexDbPath}) — a derived
 * cache must never appear in a source tree this preprocessor does not own.
 *
 * This search runs ONCE, before the worker's first turn. It cannot help the
 * worker discover a symbol introduced mid-investigation (e.g. one only found
 * by following an import chain) — the worker still has full grep/read tools
 * for that; see the skill guidance this preprocessor's candidates feed into.
 */
export const investigatePreprocessor: Preprocessor = async ({ cwd, payload, config }) => {
  const invPayload = payload as { prompt: string };

  const dbPath = await corpusIndexDbPath(cwd, config.server.stateDir);
  let { candidates, folderMap } = await withRootQueue(cwd, () => loadIndexState(cwd, dbPath, invPayload.prompt ?? ''));

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
