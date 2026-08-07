import { readdir } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { CORPUS_INDEX_DB_FILENAME } from '../engine/index-store.js';
import type { SymbolCorpusAdapter, SymbolInput } from '../engine/types.js';
import { extractBlocks, extractMarkdownSections, extractSourceSymbols } from './file-symbols.js';
import { IGNORED_DIR_NAMES } from './ignored-dirs.js';

/**
 * Repository file corpus adapter — the SECOND `SymbolCorpusAdapter`
 * implementation alongside the journal's `CorpusAdapter` (`./journal-adapter.ts`).
 * Indexes ordinary repository files into the engine's `files`/`symbols`
 * schema, selecting one of three extraction tiers by file extension. See
 * `./file-symbols.ts` for the tier implementations; this module is only
 * responsible for corpus enumeration and tier selection.
 */

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** The engine's own derived-database artifacts live in the same root as the corpus; never index them as content. */
const IGNORED_FILE_NAMES = new Set([
  CORPUS_INDEX_DB_FILENAME,
  `${CORPUS_INDEX_DB_FILENAME}-wal`,
  `${CORPUS_INDEX_DB_FILENAME}-shm`,
  `${CORPUS_INDEX_DB_FILENAME}-journal`,
]);

export class FileCorpusAdapter implements SymbolCorpusAdapter {
  readonly corpusId = 'file';
  readonly root: string;

  constructor(opts: { root: string }) {
    this.root = opts.root;
  }

  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    await this.walk(this.root, out);
    return out.sort();
  }

  private async walk(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      console.warn(`[file-adapter] cannot list directory ${dir}: ${(error as Error).message}`);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue;
        await this.walk(join(dir, entry.name), out);
        continue;
      }
      if (!entry.isFile()) continue; // skip symlinks/sockets/etc — not addressable file content
      if (IGNORED_FILE_NAMES.has(entry.name)) continue;
      const relPath = relative(this.root, join(dir, entry.name)).split(sep).join('/');
      out.push(relPath);
    }
  }

  /**
   * Select the extraction tier by extension and decode. Never throws: tier 2
   * (source) falls back to tier 3 (fixed blocks) when it cannot safely
   * delimit a declaration, and tier 3 itself is a pure string operation that
   * cannot fail on any content.
   */
  extractSymbols(relPath: string, raw: string): SymbolInput[] {
    const ext = extname(relPath).toLowerCase();
    if (MARKDOWN_EXTENSIONS.has(ext)) return extractMarkdownSections(raw);
    if (SOURCE_EXTENSIONS.has(ext)) {
      const scanned = extractSourceSymbols(raw);
      if (scanned !== null) return scanned;
      // Tier 2 could not safely delimit a declaration — fall back to tier 3
      // for this whole file rather than fail.
    }
    return extractBlocks(raw);
  }
}
