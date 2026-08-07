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
  signals(
    tokens: string[],
    pool: StoredRecord[],
    lexicalOrder?: string[],
  ): RankedList[] | Promise<RankedList[]>;
}

/**
 * One extracted addressable unit within a source file — a markdown heading
 * section, a source function/class range, or a fixed-size fallback block.
 * Unlike {@link CorpusRecord}, MANY symbols can share the same `filePath`.
 */
export interface SymbolRecord {
  /** Stable identifier, unique within the corpus (engine-assigned). */
  id: string;
  /** Adapter-relative source path (relative to the corpus root). */
  filePath: string;
  /** Heading text, function/class name, or `block-N` for fallback blocks. */
  name: string;
  /** Extraction tier that produced this symbol, e.g. `'heading' | 'function' | 'class' | 'block'`. */
  kind: string;
  /** 1-based inclusive start line within the source file. */
  startLine: number;
  /** 1-based inclusive end line within the source file. */
  endLine: number;
  /** Extracted source text for this symbol's line range. */
  body: string;
}

/** A symbol as an adapter decodes it, before the engine assigns a stable `id`/`filePath`. */
export type SymbolInput = Omit<SymbolRecord, 'id' | 'filePath'>;

/** A `files` row: purely for per-file change detection, not for search. */
export interface FileRecord {
  filePath: string;
  mtimeMs: number;
  contentHash: string;
}

/**
 * A corpus-neutral adapter for corpora where ONE source file yields MANY
 * addressable symbol rows (e.g. a repository: markdown heading sections,
 * source function/class ranges, or fixed-size fallback blocks) rather than a
 * single record. Distinct from {@link CorpusAdapter} (exactly one record per
 * file, backing the `records`/`records_fts` lexical schema). `CorpusIndex`
 * detects which contract an adapter implements by the presence of
 * `extractSymbols` (see {@link isSymbolCorpusAdapter}) and switches storage
 * mode — `files`/`symbols` tables instead of `records`/`records_fts` —
 * accordingly. The engine has no concept of what a symbol represents; that
 * stays with the adapter (e.g. the repository file adapter under
 * `../adapters/`).
 */
export interface SymbolCorpusAdapter {
  /** Stable identifier for this corpus kind, used only in diagnostics. */
  corpusId: string;
  /** Corpus root directory; adapter-relative paths resolve against this. */
  root: string;
  /** Enumerate every source file, as paths relative to the corpus root. */
  listFiles(): Promise<string[]> | string[];
  /**
   * Decode one file's raw contents into zero or more symbols. MUST NOT throw
   * solely because content is malformed or the extension is unknown — the
   * fixed-size block fallback tier guarantees every file can be decoded.
   */
  extractSymbols(relPath: string, raw: string): Promise<SymbolInput[]> | SymbolInput[];
}

/** Runtime capability check: does `adapter` implement {@link SymbolCorpusAdapter}? */
export function isSymbolCorpusAdapter(
  adapter: CorpusAdapter | SymbolCorpusAdapter,
): adapter is SymbolCorpusAdapter {
  return typeof (adapter as SymbolCorpusAdapter).extractSymbols === 'function';
}
