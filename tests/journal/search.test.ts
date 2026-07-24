import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JournalIndexStore, searchCandidatesForRecall, searchCandidatesForRecord } from '../../packages/core/src/journal/index.js';

async function makeCorpus(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mma-journal-search-'));
  await mkdir(join(root, 'nodes'), { recursive: true });
  await writeFile(join(root, 'schema.md'), '# schema\n');
  await writeFile(join(root, 'index.md'), '| id | timestamp | type | status | title | topic | tags |\n| --- | --- | --- | --- | --- | --- | --- |\n');
  await writeFile(join(root, 'log.md'), '');
  await writeFile(join(root, 'nodes', '0001-index-health.md'), `---
id: "0001"
title: "Index health rebuilds before serving"
type: "process"
topic: "journal-engine"
status: "adopted"
description: "Health checks matter."
timestamp: "2026-07-24T00:00:00.000Z"
tags:
  - index-health
  - rebuild
links: []
supersededBy: null
---

## Context

Rebuild bad indexes before serving recall.

## Consequences

- Health checks keep retrieval reliable.
`);
  await writeFile(join(root, 'nodes', '0002-superseded-history.md'), `---
id: "0002"
title: "Old history answer"
type: "knowledge"
topic: "journal-engine"
status: "superseded"
description: "Superseded node."
timestamp: "2026-07-24T00:00:00.000Z"
tags:
  - history
links: []
supersededBy: "0003"
---

## Context

Old answer.

## Consequences

- Historical only.
`);
  await writeFile(join(root, 'nodes', '0003-current-answer.md'), `---
id: "0003"
title: "Current retrieval answer"
type: "knowledge"
topic: "journal-engine"
status: "adopted"
description: "Current answer."
timestamp: "2026-07-24T00:00:00.000Z"
tags:
  - current
  - fallback
links:
  - type: "refines"
    target: "0001"
supersededBy: null
---

## Context

Current answer for retrieval.

## Consequences

- Use this answer first.
`);
  return root;
}

describe('journal search', () => {
  it('builds the derived index, provisions vectors_meta, and serves lexical retrieval without semantic state', async () => {
    const root = await makeCorpus();
    const store = await JournalIndexStore.open({ journalRoot: root });
    await store.rebuildIndex();
    const health = await store.ensureHealthy();
    expect(health.state).toBe('ready');
    const schema = await store.inspectSchema();
    expect(schema.tables).toEqual(expect.arrayContaining(['documents', 'documents_fts', 'vectors_meta']));
  });

  it('excludes superseded nodes by default and includes them only in history mode', async () => {
    const root = await makeCorpus();
    const store = await JournalIndexStore.open({ journalRoot: root });
    await store.rebuildIndex();
    const normal = await searchCandidatesForRecall(store, { prompt: 'current retrieval answer', topic: 'journal-engine', includeHistory: false });
    expect(normal.some((candidate) => candidate.nodeId === '0002')).toBe(false);
    const history = await searchCandidatesForRecall(store, { prompt: 'current retrieval answer', topic: 'journal-engine', includeHistory: true });
    expect(history.some((candidate) => candidate.nodeId === '0002')).toBe(true);
  });

  it('uses topic prefilter, tag overlap, graph-neighbor expansion, and fallback ranking', async () => {
    const root = await makeCorpus();
    const store = await JournalIndexStore.open({ journalRoot: root });
    await store.rebuildIndex();
    const record = await searchCandidatesForRecord(store, { prompt: 'index health rebuild fallback', topic: 'journal-engine' });
    expect(record[0]?.topic).toBe('journal-engine');
    expect(record.some((candidate) => candidate.nodeId === '0001')).toBe(true);
  });
});
