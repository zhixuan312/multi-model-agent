import type { SymbolInput } from '../engine/types.js';

/**
 * Dependency-free tiered extraction for the repository file adapter
 * (`./file-adapter.ts`).
 *
 * Three tiers, selected by file extension in `FileCorpusAdapter.extractSymbols`:
 *
 *  1. {@link extractMarkdownSections} — markdown/docs: one symbol per `#`
 *     heading and its body, up to (not including) the next heading.
 *  2. {@link extractSourceSymbols} — TypeScript/JavaScript-like source: a
 *     CONSERVATIVE line scanner finds top-level `function`/`class`
 *     declarations and their brace-matched range. No parser dependency is
 *     used: the `typescript` package is a development compiler dependency of
 *     this repository, not a guaranteed runtime dependency of
 *     `@zhixuan92/multi-model-agent-core`, so it must not become a
 *     production parsing dependency for this. Returns `null` when the file's
 *     braces cannot be safely matched (e.g. an odd brace count, likely from a
 *     construct this scanner does not understand) — the caller falls back to
 *     {@link extractBlocks} for the whole file in that case.
 *  3. {@link extractBlocks} — everything else, and tier 2's unsafe fallback:
 *     contiguous fixed-size line blocks. MUST NEVER THROW — this is the
 *     guaranteed-safe tier for unknown extensions and malformed/binary-ish
 *     content.
 */

/** Fixed block size for the tier-3 fallback, in source lines. */
const BLOCK_SIZE = 200;

/**
 * Tier 1: split markdown on `#`-prefixed heading lines (any level, `#`
 * through `######`). Each heading becomes one symbol whose body spans from
 * the heading line up to (not including) the next heading, or end of file.
 * A file with no headings produces zero symbols — the caller does not fall
 * back to blocks for markdown; that fallback is source-tier-specific.
 */
export function extractMarkdownSections(raw: string): SymbolInput[] {
  const lines = raw.split('\n');
  // A trailing '\n' produces one trailing empty split element that is not a
  // real source line; exclude it from end-of-file line accounting.
  const lineCount = raw.endsWith('\n') && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;

  const headings: Array<{ name: string; startLine: number }> = [];
  for (let i = 0; i < lineCount; i++) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(lines[i]);
    if (match) headings.push({ name: match[1], startLine: i + 1 });
  }

  return headings.map((heading, index) => {
    const endLine = index + 1 < headings.length ? headings[index + 1].startLine - 1 : lineCount;
    const body = lines.slice(heading.startLine - 1, endLine).join('\n');
    return { name: heading.name, kind: 'heading', startLine: heading.startLine, endLine, body };
  });
}

/**
 * Matches a top-level `function`/`class` declaration header, tolerating
 * `export`, `export default`, `declare`, and `async` modifiers. Only the
 * code portion before a trailing `//` line comment is considered, so a
 * commented-out declaration on its own line is not mistaken for a real one.
 */
const DECLARATION_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*))/;

/**
 * Per-line brace delta, ignoring braces inside string/template literals and
 * comments. Conservative, not a real lexer: it does not handle every
 * JavaScript/TypeScript edge case (e.g. regex literals containing braces),
 * by design — {@link extractSourceSymbols} treats an unbalanced result as
 * "cannot safely delimit" and the caller falls back to fixed blocks.
 */
interface ScanState {
  inString: false | '"' | "'" | '`';
  inBlockComment: boolean;
}

function scanLine(line: string, state: ScanState): { delta: number; opens: number } {
  let delta = 0;
  let opens = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.inBlockComment) {
      if (ch === '*' && next === '/') {
        state.inBlockComment = false;
        i++;
      }
      continue;
    }
    if (state.inString) {
      if (ch === '\\') {
        i++; // skip escaped character
        continue;
      }
      if (ch === state.inString) state.inString = false;
      continue;
    }
    if (ch === '/' && next === '/') break; // rest of line is a line comment
    if (ch === '/' && next === '*') {
      state.inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      state.inString = ch;
      continue;
    }
    if (ch === '{') {
      delta++;
      opens++;
    } else if (ch === '}') {
      delta--;
    }
  }
  return { delta, opens };
}

/**
 * Tier 2: a conservative, dependency-free line scanner for top-level
 * `function`/`class` declarations. Tracks brace depth (string/comment-aware)
 * across the whole file; a declaration's range runs from its header line to
 * the line where depth first returns to the level it had before the
 * declaration opened. Returns `null` — "cannot safely delimit" — if depth
 * ever goes negative (a stray unmatched `}`) or a declaration never closes by
 * end of file; the caller falls back to {@link extractBlocks} for the whole
 * file in that case, per the plan's contract.
 */
export function extractSourceSymbols(raw: string): SymbolInput[] | null {
  const lines = raw.split('\n');
  const symbols: SymbolInput[] = [];
  const state: ScanState = { inString: false, inBlockComment: false };
  let depth = 0;
  let active: { name: string; kind: string; startIndex: number; sawOpen: boolean } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!active && depth === 0) {
      const codePart = line.split('//')[0];
      const match = DECLARATION_RE.exec(codePart);
      if (match) {
        const name = match[1] ?? match[2];
        const kind = match[1] ? 'function' : 'class';
        active = { name, kind, startIndex: i, sawOpen: false };
      }
    }

    const { delta, opens } = scanLine(line, state);
    depth += delta;
    if (depth < 0) return null; // unbalanced — cannot safely delimit

    if (active) {
      if (opens > 0) active.sawOpen = true;
      if (active.sawOpen && depth === 0) {
        symbols.push({
          name: active.name,
          kind: active.kind,
          startLine: active.startIndex + 1,
          endLine: i + 1,
          body: lines.slice(active.startIndex, i + 1).join('\n'),
        });
        active = null;
      }
    }
  }

  if (active) return null; // declaration never closed — cannot safely delimit
  return symbols;
}

/**
 * Tier 3: contiguous fixed-size (200-line) blocks. Guaranteed never to
 * throw — pure string split/slice/join over whatever `raw` contains, safe
 * for an unknown extension or malformed/binary-ish content. An empty file
 * still produces exactly one (empty) block, so every file remains
 * addressable.
 */
export function extractBlocks(raw: string): SymbolInput[] {
  const lines = raw.split('\n');
  const lineCount = raw.endsWith('\n') && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;

  if (lineCount === 0) {
    return [{ name: 'block-1', kind: 'block', startLine: 1, endLine: 0, body: '' }];
  }

  const blocks: SymbolInput[] = [];
  for (let start = 1; start <= lineCount; start += BLOCK_SIZE) {
    const end = Math.min(start + BLOCK_SIZE - 1, lineCount);
    blocks.push({
      name: `block-${blocks.length + 1}`,
      kind: 'block',
      startLine: start,
      endLine: end,
      body: lines.slice(start - 1, end).join('\n'),
    });
  }
  return blocks;
}
