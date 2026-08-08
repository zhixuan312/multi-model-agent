import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { investigatePreprocessor } from '../../../../packages/server/src/application/preprocessors/investigate.js';

/**
 * Controllable stand-in for `CorpusIndex`/`FileCorpusAdapter`, so these tests
 * can force a specific phase (open/sync/search) to throw a transient or
 * non-transient error without needing a real SQLite lock-contention scenario.
 */
const control = vi.hoisted(() => ({
  openCalls: 0,
  closeCalls: 0,
  openThrows: null as (() => Error) | null,
  ensureFreshThrows: null as (() => Error) | null,
  rankedSymbolsByTokensThrows: null as (() => Error) | null,
}));

vi.mock('@zhixuan92/multi-model-agent-core', () => ({
  FileCorpusAdapter: class {
    constructor(_opts: { root: string }) {}
  },
  CorpusIndex: {
    open: vi.fn(async () => {
      control.openCalls += 1;
      if (control.openThrows) throw control.openThrows();
      return {
        ensureHealthy: async () => ({ state: 'ready' }),
        ensureFresh: async () => {
          if (control.ensureFreshThrows) throw control.ensureFreshThrows();
        },
        rankedSymbolsByTokens: async () => {
          if (control.rankedSymbolsByTokensThrows) throw control.rankedSymbolsByTokensThrows();
          return [];
        },
        folderSummaries: () => [],
        symbolsByIds: async () => [],
        close: () => {
          control.closeCalls += 1;
        },
      };
    }),
  },
}));

function transientError(): Error {
  return new Error('SQLITE_BUSY: database is locked');
}

function nonTransientError(): Error {
  return new Error('ENOENT: no such file or directory');
}

// A real (existing) directory, distinct per test: the preprocessor now
// `realpath()`s `cwd` up front (to key the external derived-index path), so
// a non-existent path — the previous fake `/tmp/...` counter — would fail
// before ever reaching the mocked `CorpusIndex` these tests exercise.
async function freshCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mma-investigate-failure-path-'));
}

/** Minimal `PreprocessorArgs.config` stand-in — only `server.stateDir` is read. */
function configWithStateDir(stateDir: string) {
  return { server: { stateDir } } as never;
}

describe('investigate preprocessor failure paths', () => {
  let stateDir: string;

  beforeEach(async () => {
    control.openCalls = 0;
    control.closeCalls = 0;
    control.openThrows = null;
    control.ensureFreshThrows = null;
    control.rankedSymbolsByTokensThrows = null;
    stateDir = await mkdtemp(join(tmpdir(), 'mma-investigate-failure-state-'));
  });

  it('retries a transient SQLITE_BUSY error across attempts, then surfaces the sync failure code once retries are exhausted', async () => {
    control.ensureFreshThrows = transientError;
    const cwd = await freshCwd();
    await expect(
      investigatePreprocessor({ cwd, payload: { prompt: 'x' }, config: configWithStateDir(stateDir) } as never),
    ).rejects.toMatchObject({
      code: 'investigate_index_sync_failed',
    });
    // MAX_INDEX_ATTEMPTS = 5: every attempt saw a transient error, so every attempt retried.
    expect(control.openCalls).toBe(5);
    expect(control.closeCalls).toBe(5);
  });

  it('does not retry a non-transient error — fails on the first attempt', async () => {
    control.ensureFreshThrows = nonTransientError;
    const cwd = await freshCwd();
    await expect(
      investigatePreprocessor({ cwd, payload: { prompt: 'x' }, config: configWithStateDir(stateDir) } as never),
    ).rejects.toMatchObject({
      code: 'investigate_index_sync_failed',
    });
    expect(control.openCalls).toBe(1);
    expect(control.closeCalls).toBe(1);
  });

  it('closes the index when ensureFresh throws', async () => {
    control.ensureFreshThrows = nonTransientError;
    const cwd = await freshCwd();
    await expect(
      investigatePreprocessor({ cwd, payload: { prompt: 'x' }, config: configWithStateDir(stateDir) } as never),
    ).rejects.toThrow();
    expect(control.closeCalls).toBe(1);
  });

  it('closes the index when SQL candidate ranking throws, and surfaces the search failure code', async () => {
    control.rankedSymbolsByTokensThrows = nonTransientError;
    const cwd = await freshCwd();
    await expect(
      investigatePreprocessor({ cwd, payload: { prompt: 'x' }, config: configWithStateDir(stateDir) } as never),
    ).rejects.toMatchObject({
      code: 'investigate_index_search_failed',
    });
    expect(control.closeCalls).toBe(1);
  });
});
