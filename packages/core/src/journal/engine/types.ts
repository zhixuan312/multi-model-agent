/**
 * Corpus-neutral engine types.
 *
 * The engine (this directory) stores and ranks generic "records" — it has no
 * concept of journals, topics, status, supersession, or typed graph edges.
 * An adapter (e.g. the journal adapter or a repository-file adapter, added in
 * later tasks under `../adapters/`) decodes its own corpus into these generic
 * shapes and may contribute extra ranked signals for the engine to fuse.
 */

/** A corpus-neutral record as an adapter decodes it from one source file. */
export interface CorpusRecord {
  /** Stable identifier, unique within the corpus. */
  id: string;
  /** Adapter-relative source path (relative to the corpus root). */
  path: string;
  /** Short human-readable title, used for lexical indexing and display. */
  title: string;
  /** Full indexable text body. */
  body: string;
}

/** A record row as persisted and returned by the engine, including derived fields. */
export interface StoredRecord extends CorpusRecord {
  /** Source file modification time in milliseconds, used for freshness comparison. */
  mtimeMs: number;
  /** SHA-256 hex digest of the raw source file content. */
  contentHash: string;
}

/** Result of a lexical FTS5 probe: record ids ordered best-first (lowest bm25). */
export interface LexicalHit {
  id: string;
  bm25: number;
}

/**
 * One ranked signal list to fuse via Reciprocal Rank Fusion. `order` is a list
 * of record ids, best match first. `via` names the signal for diagnostics
 * (e.g. `'lexical'`, `'tag'`, `'neighbor'`) and is not interpreted by the engine.
 */
export interface RankedList {
  via: string;
  order: string[];
}

/** Outcome of a schema health probe. `rebuilt` means an invalid schema was recreated. */
export interface IndexHealth {
  state: 'ready' | 'rebuilt';
}

/**
 * Corpus-neutral adapter contract. An adapter knows how to enumerate and
 * decode one kind of corpus into engine records, and may contribute extra
 * ranked signal lists (e.g. tag overlap, graph neighbours) that the engine
 * fuses with its own lexical ranking via Reciprocal Rank Fusion. The engine
 * itself never inspects what a record represents.
 */
export interface CorpusAdapter {
  /** Stable identifier for this corpus kind, used only in diagnostics. */
  corpusId: string;
  /** Corpus root directory; adapter-relative paths resolve against this. */
  root: string;
  /** Enumerate every source file, as paths relative to the corpus root. */
  listFiles(): Promise<string[]> | string[];
  /** Decode one file's raw contents into a corpus-neutral record. */
  decode(relPath: string, raw: string): Promise<CorpusRecord> | CorpusRecord;
  /**
   * Supply zero or more extra ranked signal lists (best-first record ids) to
   * fuse alongside the engine's own lexical (FTS5/BM25) ranking. Receives the
   * query tokens and the current candidate pool (already resolved to
   * records) the engine is ranking.
   */
  signals(tokens: string[], pool: StoredRecord[]): RankedList[] | Promise<RankedList[]>;
}
