import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSearch } from '../../packages/server/src/cli/search.js';
import { CorpusIndex } from '../../packages/core/src/journal/engine/index-store.js';
import { FileCorpusAdapter } from '../../packages/core/src/journal/adapters/file-adapter.js';
import { corpusIndexDbPath } from '../../packages/server/src/application/corpus-index-locator.js';

/** Build the index the way the daemon's preprocessor does, then close — the CLI
 *  only ever READS, so an index must already exist before it can answer. */
async function buildIndex(root: string, stateDir: string): Promise<void> {
  const dbPath = await corpusIndexDbPath(root, stateDir);
  const index = await CorpusIndex.open({ root, adapter: new FileCorpusAdapter({ root }), dbPath, journalMode: 'delete' });
  await index.ensureHealthy();
  await index.ensureFresh();
  index.close();
}

async function repo(): Promise<{ root: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mma-search-cli-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'mma-search-state-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'budget.ts'), 'export function enforceBudget(limit: number) {\n  return limit > 0;\n}\n');
  await writeFile(join(root, 'src', 'other.ts'), 'export function unrelatedHelper() {\n  return 1;\n}\n');
  await buildIndex(root, stateDir);
  return { root, stateDir };
}

const collect = () => {
  const out: string[] = [];
  return { out, sink: (s: string) => { out.push(s); return true; } };
};

it('answers where-is-it in one call: path, line range, symbol, and numbered body', async () => {
  const { root, stateDir } = await repo();
  const { out, sink } = collect();
  const code = await runSearch({ query: 'enforceBudget', cwd: root, stateDir, stdout: sink });
  expect(code).toBe(0);
  const text = out.join('');
  expect(text).toContain('src/budget.ts');            // path
  expect(text).toMatch(/src\/budget\.ts:\d+-\d+/);    // line range — no follow-up read needed
  expect(text).toContain('enforceBudget');            // enclosing symbol
  expect(text).toMatch(/^\s+1 \| /m);                 // body already numbered
  expect(text).not.toContain('unrelatedHelper');      // ranked, not a dump
});

it('rejects a query with no searchable tokens rather than scanning everything', async () => {
  const { root, stateDir } = await repo();
  const { out, sink } = collect();
  const errs = collect();
  const code = await runSearch({ query: 'a', cwd: root, stateDir, stdout: sink, stderr: errs.sink });
  expect(code).toBe(1);
  expect(errs.out.join('')).toContain('no searchable tokens');
  expect(out.join('')).toBe('');
});

it('emits machine-readable JSON when asked', async () => {
  const { root, stateDir } = await repo();
  const { out, sink } = collect();
  await runSearch({ query: 'enforceBudget', cwd: root, stateDir, json: true, stdout: sink });
  const parsed = JSON.parse(out.join(''));
  expect(parsed.tokens).toContain('enforcebudget');
  expect(parsed.hits[0]).toMatchObject({ name: 'enforceBudget', path: 'src/budget.ts' });
  expect(typeof parsed.hits[0].startLine).toBe('number');
});

it('reads the index without write access, as a sandboxed worker must', async () => {
  const { root, stateDir } = await repo();
  const dbPath = await corpusIndexDbPath(root, stateDir);
  const dir = dirname(dbPath);
  const { out, sink } = collect();
  await chmod(dir, 0o555);
  try {
    const code = await runSearch({ query: 'enforceBudget', cwd: root, stateDir, stdout: sink });
    expect(code).toBe(0);
    expect(out.join('')).toContain('enforceBudget');
  } finally {
    await chmod(dir, 0o755);
  }
});
