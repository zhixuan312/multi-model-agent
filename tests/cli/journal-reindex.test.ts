import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { main } from '../../packages/server/src/cli/index.js';
import { JournalIndexStore } from '../../packages/core/src/journal/index.js';

const NODE_0001 = `---
id: "0001"
title: "Existing"
type: "process"
topic: "journal-engine"
status: "adopted"
description: "Existing."
timestamp: "2026-07-24T00:00:00.000Z"
tags:
  - existing
links: []
supersededBy: null
---

## Context

Existing.

## Consequences

- Existing.
`;

const HEADER_ONLY_CATALOG =
  '| id | timestamp | type | status | title | topic | tags |\n| --- | --- | --- | --- | --- | --- | --- |\n';

async function makeJournalCwd(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mma-cli-journal-'));
  await mkdir(join(root, '.mma', 'journal', 'nodes'), { recursive: true });
  await writeFile(join(root, '.mma', 'journal', 'schema.md'), '# schema\n');
  await writeFile(join(root, '.mma', 'journal', 'index.md'), HEADER_ONLY_CATALOG);
  await writeFile(join(root, '.mma', 'journal', 'log.md'), '');
  await writeFile(join(root, '.mma', 'journal', 'nodes', '0001-existing.md'), NODE_0001);
  return root;
}

/** Run `main()` with the given argv, swallowing the sentinel exit throw. */
async function runCli(argv: string[], root: string): Promise<string> {
  const stdout: string[] = [];
  await main({
    argv: () => argv,
    cwd: () => root,
    homeDir: () => root,
    stdout: (line) => {
      stdout.push(line);
      return true;
    },
    stderr: () => true,
    exit: (() => {
      throw new Error('exit');
    }) as never,
  }).catch((error: unknown) => {
    if (!(error instanceof Error) || error.message !== 'exit') throw error;
  });
  return stdout.join('');
}

describe('mma journal reindex', () => {
  it('rebuilds index.db and regenerates index.md without mutating nodes', async () => {
    const root = await makeJournalCwd();
    const nodePathBefore = await readFile(
      join(root, '.mma', 'journal', 'nodes', '0001-existing.md'),
      'utf8',
    );

    const out = await runCli(['journal', 'reindex', '--regenerate-catalog'], root);

    expect(out).toContain('Rebuilt');
    expect(out).toContain('index.db');
    expect(existsSync(join(root, '.mma', 'journal', 'index.db'))).toBe(true);
    // index.md catalog regenerated with the node row.
    expect(await readFile(join(root, '.mma', 'journal', 'index.md'), 'utf8')).toContain('| 0001 |');
    // Node content is never mutated.
    expect(
      await readFile(join(root, '.mma', 'journal', 'nodes', '0001-existing.md'), 'utf8'),
    ).toBe(nodePathBefore);
  });

  it('does NOT mutate index.md without --regenerate-catalog', async () => {
    const root = await makeJournalCwd();

    const out = await runCli(['journal', 'reindex'], root);

    expect(out).toContain('Rebuilt');
    // index.db still built from nodes.
    expect(existsSync(join(root, '.mma', 'journal', 'index.db'))).toBe(true);
    // committed catalog untouched (still header-only).
    expect(await readFile(join(root, '.mma', 'journal', 'index.md'), 'utf8')).toBe(
      HEADER_ONLY_CATALOG,
    );
  });

  it('builds a missing index.db from node files', async () => {
    const root = await makeJournalCwd();
    expect(existsSync(join(root, '.mma', 'journal', 'index.db'))).toBe(false);

    await runCli(['journal', 'reindex'], root);

    const store = await JournalIndexStore.open({
      journalRoot: join(root, '.mma', 'journal'),
    });
    try {
      expect(store.allDocuments().map((doc) => doc.nodeId)).toEqual(['0001']);
    } finally {
      store.close();
    }
  });

  it('recovers a malformed-schema index.db and re-derives a healthy index', async () => {
    const root = await makeJournalCwd();
    const dbPath = join(root, '.mma', 'journal', 'index.db');
    // Seed a corrupt derived cache: wrong schema version + missing required tables.
    const bad = new DatabaseSync(dbPath);
    bad.exec('CREATE TABLE stray (x TEXT);');
    bad.exec('PRAGMA user_version = 999;');
    bad.close();

    const out = await runCli(['journal', 'reindex'], root);
    expect(out).toContain('Rebuilt');

    const store = await JournalIndexStore.open({
      journalRoot: join(root, '.mma', 'journal'),
    });
    try {
      const schema = await store.inspectSchema();
      expect(schema.tables).toEqual(
        expect.arrayContaining(['records', 'records_fts']),
      );
      expect(store.allDocuments().map((doc) => doc.nodeId)).toEqual(['0001']);
    } finally {
      store.close();
    }
  });

  it('rejects an unknown journal subcommand with a nonzero exit', async () => {
    const root = await makeJournalCwd();
    let exitCode = -1;
    const stderr: string[] = [];
    await main({
      argv: () => ['journal', 'bogus'],
      cwd: () => root,
      homeDir: () => root,
      stdout: () => true,
      stderr: (line) => {
        stderr.push(line);
        return true;
      },
      exit: ((code: number) => {
        exitCode = code;
        throw new Error('exit');
      }) as never,
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== 'exit') throw error;
    });
    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('unknown subcommand');
  });
});
