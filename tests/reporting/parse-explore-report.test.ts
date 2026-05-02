import { describe, expect, it } from 'vitest';
import { parseExploreReport } from '../../packages/core/src/reporting/parse-explore-report.js';

const mkThread = (
  n: number,
  title: string,
  summary: string,
  internalAnchors: string[],
  externalSources: string[],
  divergenceAxis: string,
) => `## Thread ${n}: ${title}
${summary}

**Internal anchors:**
${internalAnchors.map(a => `- ${a}`).join('\n') || '- (none)'}

**External sources:**
${externalSources.map(s => `- ${s}`).join('\n') || '- (none)'}

**Divergence axis:** ${divergenceAxis}`;

const nextStep = (text: string) => `## Recommended next step
${text}`;

const preamble = `## Context recap
Recap text.
---

Plan files for reference (read on demand if you need adjacent context):
  - /some/path/plan.md

Additional context: some context here.`;

describe('parseExploreReport — discriminated union', () => {
  it('kind=no_structured_report when output is empty', () => {
    expect(parseExploreReport('').kind).toBe('no_structured_report');
    expect(parseExploreReport('   ').kind).toBe('no_structured_report');
  });

  it('kind=no_structured_report when output has no thread headers', () => {
    expect(parseExploreReport('## Notes\nSome text.\n').kind).toBe('no_structured_report');
    expect(parseExploreReport('Just some prose.').kind).toBe('no_structured_report');
  });

  it('kind=no_structured_report when only preamble sections exist', () => {
    expect(parseExploreReport(preamble).kind).toBe('no_structured_report');
  });

  it('kind=structured_report with malformed=true when Recommended next step exists but no threads', () => {
    const r = parseExploreReport(nextStep('Do thread 1.'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.diagnostics.malformed).toBe(true);
    expect(r.report.diagnostics.insufficientThreads).toBe(true);
    expect(r.report.threads).toEqual([]);
    expect(r.report.recommendedNextStep).toBe('Do thread 1.');
  });

  it('kind=structured_report with malformed=true when Recommended next step exists but is empty', () => {
    const r = parseExploreReport('## Recommended next step\n   ');
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.diagnostics.malformed).toBe(true);
    expect(r.report.diagnostics.insufficientThreads).toBe(true);
    expect(r.report.threads).toEqual([]);
    expect(r.report.recommendedNextStep).toBeNull();
  });

  it('kind=no_structured_report for non-string runtime input', () => {
    expect(parseExploreReport(null as unknown as string).kind).toBe('no_structured_report');
    expect(parseExploreReport(undefined as unknown as string).kind).toBe('no_structured_report');
  });
});

describe('parseExploreReport — thread extraction', () => {
  it('parses a single complete thread', () => {
    const out = mkThread(1, 'Add Caching Layer', 'A caching layer would reduce latency.', ['src/cache.ts:12 — existing cache stub'], ['arxiv:2106.09680 — CacheLib paper'], 'Focus on read-path optimization.');
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(1);
    expect(r.report.diagnostics.malformed).toBe(false);
    expect(r.report.diagnostics.insufficientThreads).toBe(true);
    expect(r.report.diagnostics.droppedThreads).toEqual([]);

    const t = r.report.threads[0];
    expect(t.index).toBe(1);
    expect(t.title).toBe('Add Caching Layer');
    expect(t.summary).toBe('A caching layer would reduce latency.');
    expect(t.internalAnchors).toEqual(['src/cache.ts:12 — existing cache stub']);
    expect(t.externalSources).toEqual(['arxiv:2106.09680 — CacheLib paper']);
    expect(t.divergenceAxis).toBe('Focus on read-path optimization.');
  });

  it('parses multiple threads with mixed internal/external sentinels', () => {
    const t1 = mkThread(1, 'T1', 'Summary 1.', ['src/a.ts:1 — anchor'], [], 'Axis 1.');
    const t2 = mkThread(2, 'T2', 'Summary 2.', [], ['arxiv:1 — paper'], 'Axis 2.');
    const t3 = mkThread(3, 'T3', 'Summary 3.', ['src/b.ts:2 — anchor'], ['arxiv:2 — paper'], 'Axis 3.');
    const t4 = mkThread(4, 'T4', 'Summary 4.', ['(no internal anchor — fully greenfield)'], ['(no external source found)'], 'Axis 4 — different angle.');

    const out = [t1, t2, t3, t4, nextStep('Pursue T1.')].join('\n\n');
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;

    expect(r.report.threads).toHaveLength(4);
    expect(r.report.recommendedNextStep).toBe('Pursue T1.');
    expect(r.report.diagnostics).toEqual({
      malformed: false,
      insufficientThreads: false,
      droppedThreads: [],
      droppedThreadDiagnostics: [],
    });

    expect(r.report.threads[3].internalAnchors).toEqual(['(no internal anchor — fully greenfield)']);
    expect(r.report.threads[3].externalSources).toEqual(['(no external source found)']);
  });

  it('preserves preamble sections and still extracts threads', () => {
    const t1 = mkThread(1, 'T1', 'S1.', ['a'], ['b'], 'Axis 1.');
    const t2 = mkThread(2, 'T2', 'S2.', ['c'], ['d'], 'Axis 2.');
    const t3 = mkThread(3, 'T3', 'S3.', ['e'], ['f'], 'Axis 3.');
    const out = [preamble, t1, t2, t3, nextStep('Do T1.')].join('\n\n');
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(3);
    expect(r.report.diagnostics.insufficientThreads).toBe(false);
    expect(r.report.diagnostics.malformed).toBe(false);
  });
});

describe('parseExploreReport — dropped threads', () => {
  it('drops a thread missing Internal anchors field', () => {
    const bad = `## Thread 1: Bad Thread
Summary text.

**External sources:**
- src

**Divergence axis:** Axis.`;
    const good = mkThread(2, 'Good', 'S.', ['a'], ['b'], 'Axis 2.');
    const r = parseExploreReport([bad, good].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(1);
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread 1: Bad Thread']);
    expect(r.report.diagnostics.malformed).toBe(false);
    expect(r.report.diagnostics.insufficientThreads).toBe(true);
  });

  it('drops a thread missing External sources field', () => {
    const bad = `## Thread 1: Bad Thread
Summary.

**Internal anchors:**
- a

**Divergence axis:** Axis.`;
    const good = mkThread(2, 'Good', 'S.', ['a'], ['b'], 'Axis 2.');
    const r = parseExploreReport([bad, good].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread 1: Bad Thread']);
  });

  it('drops a thread missing Divergence axis field', () => {
    const bad = `## Thread 1: Bad Thread
Summary.

**Internal anchors:**
- a

**External sources:**
- b`;
    const good = mkThread(2, 'Good', 'S.', ['a'], ['b'], 'Axis 2.');
    const r = parseExploreReport([bad, good].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread 1: Bad Thread']);
  });

  it('drops a thread with empty divergence axis', () => {
    const bad = `## Thread 1: Bad Thread
Summary.

**Internal anchors:**
- a

**External sources:**
- b

**Divergence axis:**   `;
    const good = mkThread(2, 'Good', 'S.', ['a'], ['b'], 'Axis 2.');
    const r = parseExploreReport([bad, good].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.diagnostics.droppedThreads).toContain('Thread 1: Bad Thread');
  });

  it('drops a thread with non-integer index', () => {
    const bad = `## Thread X: Bad Thread
Summary.

**Internal anchors:**
- a

**External sources:**
- b

**Divergence axis:** Axis.`;
    const good = mkThread(1, 'Good', 'S.', ['a'], ['b'], 'Axis.');
    const r = parseExploreReport([bad, good].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(1);
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread X: Bad Thread']);
  });

  it('drops a thread with index 0', () => {
    const bad = `## Thread 0: Bad Thread
Summary.

**Internal anchors:**
- a

**External sources:**
- b

**Divergence axis:** Axis.`;
    const good = mkThread(1, 'Good', 'S.', ['a'], ['b'], 'Axis.');
    const r = parseExploreReport([bad, good].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.diagnostics.droppedThreads).toContain('Thread 0: Bad Thread');
  });

  it('drops a thread with empty title', () => {
    const bad = `## Thread 1:  
Summary.

**Internal anchors:**
- a

**External sources:**
- b

**Divergence axis:** Axis.`;
    const good = mkThread(2, 'Good', 'S.', ['a'], ['b'], 'Axis.');
    const r = parseExploreReport([bad, good].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.diagnostics.droppedThreads).toContain('Thread 1:');
  });

  it('drops a thread with empty summary', () => {
    const bad = `## Thread 1: Bad Thread


**Internal anchors:**
- a

**External sources:**
- b

**Divergence axis:** Axis.`;
    const good = mkThread(2, 'Good', 'S.', ['a'], ['b'], 'Axis 2.');
    const r = parseExploreReport([bad, good].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.diagnostics.droppedThreads).toContain('Thread 1: Bad Thread');
  });

  it('drops a thread with empty internal anchors section', () => {
    const bad = `## Thread 1: Bad Thread
Summary.

**Internal anchors:**

**External sources:**
- b

**Divergence axis:** Axis.`;
    const good = mkThread(2, 'Good', 'S.', ['a'], ['b'], 'Axis 2.');
    const r = parseExploreReport([bad, good].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.diagnostics.droppedThreads).toContain('Thread 1: Bad Thread');
    expect(r.report.diagnostics.droppedThreadDiagnostics).toContainEqual({
      header: 'Thread 1: Bad Thread',
      reason: 'empty_internal_anchors',
      detail: 'Internal anchors has no bullet entries',
    });
  });

  it('drops a thread with empty external sources section', () => {
    const bad = `## Thread 1: Bad Thread
Summary.

**Internal anchors:**
- a

**External sources:**

**Divergence axis:** Axis.`;
    const good = mkThread(2, 'Good', 'S.', ['a'], ['b'], 'Axis 2.');
    const r = parseExploreReport([bad, good].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.diagnostics.droppedThreads).toContain('Thread 1: Bad Thread');
    expect(r.report.diagnostics.droppedThreadDiagnostics).toContainEqual({
      header: 'Thread 1: Bad Thread',
      reason: 'empty_external_sources',
      detail: 'External sources has no bullet entries',
    });
  });

  it('malformed=true when all threads are dropped', () => {
    const bad1 = `## Thread 1: Bad
Summary.

**Internal anchors:**
- a

**External sources:**
- b`;
    const bad2 = `## Thread 2: Also Bad
Summary.

**Internal anchors:**
- a

**Divergence axis:** Axis.`;
    const r = parseExploreReport([bad1, bad2].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toEqual([]);
    expect(r.report.diagnostics.malformed).toBe(true);
    expect(r.report.diagnostics.insufficientThreads).toBe(true);
    expect(r.report.diagnostics.droppedThreads).toHaveLength(2);
    expect(r.report.diagnostics.droppedThreadDiagnostics.map(d => d.reason)).toEqual([
      'missing_field',
      'missing_field',
    ]);
  });

  it('records reasons for invalid header, invalid index, empty title, and empty summary drops', () => {
    const badHeader = `## Thread 1 Bad Header
Summary.

**Internal anchors:**
- a

**External sources:**
- b

**Divergence axis:** Axis.`;
    const badIndex = `## Thread nope: Bad Index
Summary.

**Internal anchors:**
- a

**External sources:**
- b

**Divergence axis:** Axis.`;
    const emptyTitle = `## Thread 1:   
Summary.

**Internal anchors:**
- a

**External sources:**
- b

**Divergence axis:** Axis.`;
    const emptySummary = `## Thread 2: Empty Summary

**Internal anchors:**
- a

**External sources:**
- b

**Divergence axis:** Axis.`;

    const r = parseExploreReport([badHeader, badIndex, emptyTitle, emptySummary].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.diagnostics.droppedThreadDiagnostics).toEqual([
      {
        header: 'Thread 1 Bad Header',
        reason: 'invalid_header',
        detail: 'thread header must match "Thread <positive integer>: <title>"',
      },
      {
        header: 'Thread nope: Bad Index',
        reason: 'invalid_index',
        detail: 'thread index must be a positive safe integer',
      },
      {
        header: 'Thread 1:',
        reason: 'empty_title',
        detail: 'thread title is empty',
      },
      {
        header: 'Thread 2: Empty Summary',
        reason: 'empty_summary',
        detail: 'summary before Internal anchors is empty',
      },
    ]);
  });
});

describe('parseExploreReport — Required field non-empty validation', () => {
  it('drops a thread with empty summary (whitespace only)', () => {
    const out = `## Thread 1: No Summary
   

**Internal anchors:**
- src/a.ts:1 — anchor

**External sources:**
- arxiv:1 — paper

**Divergence axis:** Axis 1.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(0);
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread 1: No Summary']);
  });

  it('drops a thread with empty internal anchors (no bullet lines)', () => {
    const out = `## Thread 1: No Anchors
Summary text.

**Internal anchors:**


**External sources:**
- arxiv:1 — paper

**Divergence axis:** Axis 1.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(0);
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread 1: No Anchors']);
  });

  it('drops a thread with empty external sources (no bullet lines)', () => {
    const out = `## Thread 1: No Sources
Summary text.

**Internal anchors:**
- src/a.ts:1 — anchor

**External sources:**


**Divergence axis:** Axis 1.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(0);
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread 1: No Sources']);
  });

  it('drops a thread where summary is just blank lines before Internal anchors', () => {
    const out = `## Thread 1: Blank Summary


**Internal anchors:**
- src/a.ts:1 — anchor

**External sources:**
- arxiv:1 — paper

**Divergence axis:** Axis.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(0);
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread 1: Blank Summary']);
  });
});

describe('parseExploreReport — parseBullets strictness', () => {
  it('filters out non-bullet lines from anchor/source lists', () => {
    const out = `## Thread 1: Mixed Bullets
Summary text.

**Internal anchors:**
- src/a.ts:1 — valid bullet
not a bullet line
just plain text
* src/b.ts:2 — asterisk bullet

**External sources:**
- arxiv:1 — valid source

**Divergence axis:** Axis 1.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(1);
    const t = r.report.threads[0];
    expect(t.internalAnchors).toEqual(['src/a.ts:1 — valid bullet', 'src/b.ts:2 — asterisk bullet']);
    expect(t.externalSources).toEqual(['arxiv:1 — valid source']);
  });

  it('drops a thread where all internal anchor lines are non-bullets', () => {
    const out = `## Thread 1: No Bullet Anchors
Summary.

**Internal anchors:**
not a bullet
also not a bullet

**External sources:**
- arxiv:1 — source

**Divergence axis:** Axis.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(0);
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread 1: No Bullet Anchors']);
  });

  it('drops a thread where all external source lines are non-bullets', () => {
    const out = `## Thread 1: No Bullet Sources
Summary.

**Internal anchors:**
- src/a.ts:1 — anchor

**External sources:**
plain text here
more plain text

**Divergence axis:** Axis.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(0);
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread 1: No Bullet Sources']);
  });
});

describe('parseExploreReport — case-insensitive field labels', () => {
  const mkThreadWithCasing = (
    n: number,
    title: string,
    internalLabel: string,
    externalLabel: string,
    divergenceLabel: string,
  ) => `## Thread ${n}: ${title}
Summary text.

**${internalLabel}**
- src/a.ts:1 — anchor

**${externalLabel}**
- arxiv:1 — paper

**${divergenceLabel}** Axis.`;

  it('accepts lowercase field labels', () => {
    const out = mkThreadWithCasing(1, 'T1', 'internal anchors:', 'external sources:', 'divergence axis:');
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(1);
    const t = r.report.threads[0];
    expect(t.summary).toBe('Summary text.');
    expect(t.internalAnchors).toEqual(['src/a.ts:1 — anchor']);
    expect(t.externalSources).toEqual(['arxiv:1 — paper']);
    expect(t.divergenceAxis).toBe('Axis.');
  });

  it('accepts uppercase field labels', () => {
    const out = mkThreadWithCasing(1, 'T1', 'INTERNAL ANCHORS:', 'EXTERNAL SOURCES:', 'DIVERGENCE AXIS:');
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(1);
    const t = r.report.threads[0];
    expect(t.summary).toBe('Summary text.');
    expect(t.internalAnchors).toEqual(['src/a.ts:1 — anchor']);
    expect(t.externalSources).toEqual(['arxiv:1 — paper']);
    expect(t.divergenceAxis).toBe('Axis.');
  });

  it('accepts title-case field labels', () => {
    const out = mkThreadWithCasing(1, 'T1', 'Internal Anchors:', 'External Sources:', 'Divergence Axis:');
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(1);
    const t = r.report.threads[0];
    expect(t.summary).toBe('Summary text.');
  });

  it('summary extraction works regardless of Internal anchors casing', () => {
    // With lowercase Internal anchors, the old case-sensitive indexOf would return -1
    const out = `## Thread 1: Casing Test
Multi-paragraph summary
that spans two lines.

**internal anchors:**
- src/a.ts:1 — anchor

**external sources:**
- arxiv:1 — paper

**divergence axis:** Axis.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(1);
    expect(r.report.threads[0].summary).toContain('Multi-paragraph summary');
    expect(r.report.threads[0].summary).toContain('that spans two lines.');
  });
});

describe('parseExploreReport — malformed field labels', () => {
  it('drops a thread with singular Internal anchor label (not matching)', () => {
    const out = `## Thread 1: Singular Labels
Summary text.

**Internal anchor:**
- src/a.ts:1 — anchor

**External sources:**
- arxiv:1 — paper

**Divergence axis:** Axis.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(0);
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread 1: Singular Labels']);
  });

  it('drops a thread with singular External source label', () => {
    const out = `## Thread 1: Singular Source
Summary text.

**Internal anchors:**
- src/a.ts:1 — anchor

**External source:**
- arxiv:1 — paper

**Divergence axis:** Axis.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(0);
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread 1: Singular Source']);
  });

  it('drops a thread with Divergence label missing axis', () => {
    const out = `## Thread 1: Missing Axis
Summary text.

**Internal anchors:**
- src/a.ts:1 — anchor

**External sources:**
- arxiv:1 — paper

**Divergence:** Something.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(0);
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread 1: Missing Axis']);
    expect(r.report.diagnostics.droppedThreadDiagnostics).toEqual([
      {
        header: 'Thread 1: Missing Axis',
        reason: 'missing_field',
        detail: 'missing required field(s): divergenceAxis',
      },
    ]);
  });

  it('drops a thread without bold markers on field labels', () => {
    const out = `## Thread 1: No Bold
Summary text.

Internal anchors:
- src/a.ts:1 — anchor

External sources:
- arxiv:1 — paper

Divergence axis: Axis.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(0);
    expect(r.report.diagnostics.droppedThreads).toEqual(['Thread 1: No Bold']);
  });
});

describe('parseExploreReport — Recommended next step', () => {
  it('extracts Recommended next step when present', () => {
    const t1 = mkThread(1, 'T1', 'S.', ['a'], ['src'], 'Axis 1.');
    const t2 = mkThread(2, 'T2', 'S.', ['b'], ['src'], 'Axis 2.');
    const t3 = mkThread(3, 'T3', 'S.', ['c'], ['src'], 'Axis 3.');
    const out = [t1, t2, t3, nextStep('Pursue Thread 1 — best cost/benefit ratio.')].join('\n\n');
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.recommendedNextStep).toBe('Pursue Thread 1 — best cost/benefit ratio.');
  });

  it('returns null for Recommended next step when absent', () => {
    const t1 = mkThread(1, 'T1', 'S.', ['a'], ['src'], 'Axis 1.');
    const t2 = mkThread(2, 'T2', 'S.', ['b'], ['src'], 'Axis 2.');
    const t3 = mkThread(3, 'T3', 'S.', ['c'], ['src'], 'Axis 3.');
    const r = parseExploreReport([t1, t2, t3].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.recommendedNextStep).toBeNull();
  });

  it('returns null for Recommended next step when present but empty with threads', () => {
    const t1 = mkThread(1, 'T1', 'S.', ['a'], ['src'], 'Axis 1.');
    const r = parseExploreReport([t1, '## Recommended next step\n   '].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.recommendedNextStep).toBeNull();
    expect(r.report.threads).toHaveLength(1);
  });

  it('handles Recommended next step at end of report with preamble', () => {
    const t1 = mkThread(1, 'T1', 'S.', ['a'], ['src'], 'Axis 1.');
    const t2 = mkThread(2, 'T2', 'S.', ['b'], ['src'], 'Axis 2.');
    const t3 = mkThread(3, 'T3', 'S.', ['c'], ['src'], 'Axis 3.');
    const out = [preamble, t1, t2, t3, nextStep('Start with T2.')].join('\n\n');
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.recommendedNextStep).toBe('Start with T2.');
    expect(r.report.threads).toHaveLength(3);
  });
});

describe('parseExploreReport — divergence axis distinctness', () => {
  it('each thread preserves its own divergence axis', () => {
    const t1 = mkThread(1, 'Cost Focus', 'S.', ['a'], ['b'], 'Focus on minimizing cost per operation.');
    const t2 = mkThread(2, 'Latency Focus', 'S.', ['c'], ['d'], 'Focus on reducing p99 latency.');
    const t3 = mkThread(3, 'Simplicity Focus', 'S.', ['e'], ['f'], 'Focus on least architectural change.');
    const r = parseExploreReport([t1, t2, t3].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads.map(t => t.divergenceAxis)).toEqual([
      'Focus on minimizing cost per operation.',
      'Focus on reducing p99 latency.',
      'Focus on least architectural change.',
    ]);
  });

  it('does not require 3 threads to be valid (that is insufficientThreads, not dropped)', () => {
    const t1 = mkThread(1, 'T1', 'S.', ['a'], ['b'], 'Axis 1.');
    const t2 = mkThread(2, 'T2', 'S.', ['c'], ['d'], 'Axis 2.');
    const r = parseExploreReport([t1, t2].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(2);
    expect(r.report.diagnostics.insufficientThreads).toBe(true);
    expect(r.report.diagnostics.malformed).toBe(false);
    expect(r.report.diagnostics.droppedThreads).toEqual([]);
  });

  it('5 threads is a valid count (no upper limit)', () => {
    const threads = [1, 2, 3, 4, 5].map(n =>
      mkThread(n, `T${n}`, 'S.', ['a'], ['b'], `Axis ${n}.`),
    );
    const r = parseExploreReport(threads.join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(5);
    expect(r.report.diagnostics.insufficientThreads).toBe(false);
  });
});

describe('parseExploreReport — edge cases', () => {
  it('threads can appear in non-sequential numeric order and still parse', () => {
    const t3 = mkThread(3, 'T3', 'S.', ['a'], ['b'], 'Axis 3.');
    const t1 = mkThread(1, 'T1', 'S.', ['a'], ['b'], 'Axis 1.');
    const r = parseExploreReport([t3, t1].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads.map(t => t.index)).toEqual([3, 1]);
  });

  it('drops duplicate thread indexes after the first valid occurrence', () => {
    const first = mkThread(1, 'First', 'S.', ['a'], ['b'], 'Axis 1.');
    const duplicate = mkThread(1, 'Duplicate', 'S.', ['c'], ['d'], 'Axis duplicate.');
    const r = parseExploreReport([first, duplicate].join('\n\n'));
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads.map(t => t.title)).toEqual(['First']);
    expect(r.report.diagnostics.droppedThreadDiagnostics).toEqual([
      {
        header: 'Thread 1: Duplicate',
        reason: 'duplicate_index',
        detail: 'thread index 1 was already parsed',
      },
    ]);
  });

  it('drops a thread whose required fields are out of order', () => {
    const out = `## Thread 1: Out Of Order
Summary text.

**External sources:**
- arxiv:1 — paper

**Internal anchors:**
- src/a.ts:1 — anchor

**Divergence axis:** Axis.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(0);
    expect(r.report.diagnostics.droppedThreadDiagnostics).toEqual([
      {
        header: 'Thread 1: Out Of Order',
        reason: 'out_of_order_field',
        detail: 'fields must appear in order: summary, Internal anchors, External sources, Divergence axis',
      },
    ]);
  });

  it('drops a thread with duplicate field labels', () => {
    const out = `## Thread 1: Duplicate Field
Summary text.

**Internal anchors:**
- src/a.ts:1 — anchor

**External sources:**
- arxiv:1 — paper

**External sources:**
- arxiv:2 — paper

**Divergence axis:** Axis.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(0);
    expect(r.report.diagnostics.droppedThreadDiagnostics).toEqual([
      {
        header: 'Thread 1: Duplicate Field',
        reason: 'duplicate_field',
        detail: 'duplicate field label: External sources:',
      },
    ]);
  });

  it('summary text before Internal anchors can span multiple paragraphs', () => {
    const out = `## Thread 1: Multi-Paragraph
First paragraph of summary.

Second paragraph with more detail.

**Internal anchors:**
- src/a.ts:1 — thing

**External sources:**
- arxiv:1 — paper

**Divergence axis:** Axis.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads[0].summary).toContain('First paragraph of summary.');
    expect(r.report.threads[0].summary).toContain('Second paragraph with more detail.');
  });

  it('handles asterisk bullets in internal/external lists', () => {
    const out = `## Thread 1: Asterisks
Summary.

**Internal anchors:**
* src/a.ts:1 — anchor a
* src/b.ts:2 — anchor b

**External sources:**
* arxiv:1 — paper

**Divergence axis:** Axis.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads[0].internalAnchors).toEqual(['src/a.ts:1 — anchor a', 'src/b.ts:2 — anchor b']);
    expect(r.report.threads[0].externalSources).toEqual(['arxiv:1 — paper']);
  });

  it('handles empty internal anchors (none sentinel)', () => {
    const out = `## Thread 1: Greenfield
Summary.

**Internal anchors:**
- (no internal anchor — fully greenfield)

**External sources:**
- arxiv:1 — paper

**Divergence axis:** Axis.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads[0].internalAnchors).toEqual(['(no internal anchor — fully greenfield)']);
  });

  it('handles empty external sources (none sentinel)', () => {
    const out = `## Thread 1: Internal Only
Summary.

**Internal anchors:**
- src/a.ts:1 — anchor

**External sources:**
- (no external source found)

**Divergence axis:** Axis.`;
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads[0].externalSources).toEqual(['(no external source found)']);
  });

  it('handles extra blank lines between sections gracefully', () => {
    const t1 = mkThread(1, 'T1', 'S.', ['a'], ['b'], 'Axis 1.');
    const t2 = mkThread(2, 'T2', 'S.', ['c'], ['d'], 'Axis 2.');
    const t3 = mkThread(3, 'T3', 'S.', ['e'], ['f'], 'Axis 3.');
    const out = [t1, '', '', t2, '', t3].join('\n\n');
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(3);
  });

  it('extra ## sections that are not threads do not interfere', () => {
    const t1 = mkThread(1, 'T1', 'S.', ['a'], ['b'], 'Axis 1.');
    const t2 = mkThread(2, 'T2', 'S.', ['c'], ['d'], 'Axis 2.');
    const t3 = mkThread(3, 'T3', 'S.', ['e'], ['f'], 'Axis 3.');
    const out = [`## Context recap\nSome context.\n`, `## Notes\nA note.\n`, t1, t2, t3].join('\n\n');
    const r = parseExploreReport(out);
    expect(r.kind).toBe('structured_report');
    if (r.kind !== 'structured_report') return;
    expect(r.report.threads).toHaveLength(3);
  });
});
