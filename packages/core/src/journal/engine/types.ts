/**
 * Corpus-neutral engine types.
 *
 * The engine (this directory) stores and ranks generic "records". Domain
 * semantics stay with the adapter, which decodes its corpus into these generic
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
  /**
   * Optional indexed SQL filter/facet fields. Unlike `adapterMeta` (an opaque
   * blob the engine never parses), `topic` and `status` are stored as real,
   * INDEXED columns on the `records` table (see `../engine/index-store.ts`'s
   * `ensureSchema`) — so a query can prefilter and scope candidates in SQL
   * (equality on `topic`, visibility on `status`) before any row is read into
   * JS. The engine treats both as opaque scoping values: it only ever
   * compares them for equality, never interprets what they mean. Today only
   * the journal adapter (`../adapters/journal-adapter.ts`) supplies them, for
   * its topic prefilter and superseded-status visibility; an adapter that has
   * no use for SQL-side filtering simply omits them (stored as `''`).
   */
  topic?: string;
  status?: string;
  /**
   * Opaque adapter-owned metadata, persisted and returned verbatim alongside
   * the record. The engine never parses or interprets this string — it exists
   * so an adapter can persist its own metadata in the SAME row, SAME
   * statement, and SAME transaction as the record itself, without a second
   * database connection. `undefined`/omitted persists as `NULL`.
   */
  adapterMeta?: string;
}

/** A record row as persisted and returned by the engine, including derived fields. */
export interface StoredRecord extends CorpusRecord {
  /** Source file modification time in milliseconds, used for freshness comparison. */
  mtimeMs: number;
  /** SHA-256 hex digest of the raw source file content. */
  contentHash: string;
}

/**
 * A {@link StoredRecord} projection WITHOUT `body`. Ranking (lexical fusion,
 * tag overlap, graph-neighbour expansion) needs only a record's id and
 * metadata, never its body text — `body` is needed only once ranking has
 * narrowed the corpus down to the records that will actually be returned.
 * Fetching this shape instead of {@link StoredRecord} for the whole corpus is
 * what lets a query avoid materializing every record's body on every call.
 */
export type StoredRecordMeta = Omit<StoredRecord, 'body'>;

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
   * records) the engine is ranking. `pool` carries metadata only — no
   * `body` — since a signal (tag overlap, graph neighbours, ...) is computed
   * from an adapter's own metadata, never from record text.
   */
  signals(
    tokens: string[],
    pool: StoredRecordMeta[],
    lexicalOrder?: string[],
  ): RankedList[] | Promise<RankedList[]>;
  /**
   * Optional cheap "has anything been added or removed" signal: the
   * modification time of the directory {@link listFiles} enumerates, or
   * `null` if unavailable. When an adapter supplies this, the engine's {@link
   * CorpusIndex.ensureFresh} pre-checks it (a single `stat`, independent of
   * corpus size) and SKIPS the full `listFiles()` + record-count comparison
   * entirely whenever it is unchanged since the last check — the common case
   * for the overwhelming majority of queries, where nothing was added or
   * removed since the last one. A directory's own mtime updates whenever an
   * entry is added or removed (standard filesystem behavior), so this is an
   * exact, not approximate, short-circuit for add/remove drift — the ONLY
   * drift {@link CorpusIndex.ensureFresh}'s count comparison ever detects;
   * content edits to an existing file are unaffected either way (that is a
   * different explicit-rebuild/sync concern). Adapters that omit this
   * (`undefined`) get today's unconditional `listFiles()` behavior, unchanged.
   */
  rootMtimeMs?(): Promise<number | null> | number | null;
}

