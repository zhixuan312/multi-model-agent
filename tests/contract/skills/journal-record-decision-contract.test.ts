import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REFINER_SCHEMAS, parseRecordDecisions } from '../../../packages/core/src/unified/refiner-schemas.js';

const SAMPLE_DECISIONS = [
  {
    learning: 'Use decide-then-apply.',
    decision: {
      kind: 'create',
      title: 'Decide then apply',
      type: 'process',
      topic: 'journal-engine',
      tags: ['deterministic'],
      links: [],
      status: 'adopted',
      description: 'Deterministic write path.',
      context: 'ctx',
      consequences: '- consequence',
    },
  },
  {
    learning: 'Already covered.',
    decision: { kind: 'merge', targetNodeId: '0001', reason: 'covered' },
  },
];

describe('journal record decision contract', () => {
  it('exposes a decision schema for JournalRecordDecision[]', () => {
    const schema = REFINER_SCHEMAS.journal_record_decision;
    expect(schema).toBeDefined();
    const parsed = schema?.parse(SAMPLE_DECISIONS);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('parseRecordDecisions extracts fenced JSON into ApplyRecordInput[]', () => {
    const fenced = '```json\n' + JSON.stringify(SAMPLE_DECISIONS) + '\n```';
    const parsed = parseRecordDecisions(fenced);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.decision.kind).toBe('create');
    expect(parsed[1]?.decision.kind).toBe('merge');
  });

  it('takes the LAST fenced block, so a draft cannot be applied instead of the final answer', () => {
    // This extractor took the FIRST block — the exact defect `reviewer-output-parser`'s own
    // extractor was fixed for ("Last-JSON-block extraction prevents LLM preamble from corrupting
    // parsed output"). The fix reached one copy of the idea and not this one.
    //
    // The consequence here is worse than a corrupted answer: these decisions are applied
    // DETERMINISTICALLY to the journal graph, so an implementer that reasons in a draft block and
    // then emits the final one had its draft written — wrong nodes created, refined, or
    // superseded, with nothing reporting a problem.
    const draft = [{ ...SAMPLE_DECISIONS[0], learning: 'DRAFT — superseded by the block below' }];
    const output = [
      'Here is my first pass:',
      '```json',
      JSON.stringify(draft),
      '```',
      'On reflection, the final decisions are:',
      '```json',
      JSON.stringify(SAMPLE_DECISIONS),
      '```',
    ].join('\n');

    const parsed = parseRecordDecisions(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.learning).toBe('Use decide-then-apply.');
    expect(parsed.some((d) => d.learning.startsWith('DRAFT')), 'the draft must never be applied').toBe(false);
  });

  it('parseRecordDecisions parses bare JSON without a fence', () => {
    const parsed = parseRecordDecisions(JSON.stringify(SAMPLE_DECISIONS));
    expect(parsed).toHaveLength(2);
  });

  it('parseRecordDecisions throws on malformed JSON', () => {
    expect(() => parseRecordDecisions('```json\nnot json\n```')).toThrow();
  });

  it('parseRecordDecisions throws on schema mismatch', () => {
    const bad = '```json\n' + JSON.stringify([{ learning: 'x', decision: { kind: 'bogus' } }]) + '\n```';
    expect(() => parseRecordDecisions(bad)).toThrow();
  });

  it('rejects a refine decision that omits targetNodeId', () => {
    const bad = [{
      learning: 'refine without a target',
      decision: {
        kind: 'refine',
        title: 'Refined', type: 'process', topic: 'journal-engine', tags: ['t'], links: [],
        status: 'adopted', description: 'd', context: 'ctx', consequences: '- c',
      },
    }];
    expect(() => parseRecordDecisions(JSON.stringify(bad))).toThrow();
  });

  it('rejects a supersede decision that omits targetNodeId', () => {
    const bad = [{
      learning: 'supersede without a target',
      decision: {
        kind: 'supersede',
        title: 'Superseding', type: 'process', topic: 'journal-engine', tags: ['t'], links: [],
        status: 'adopted', description: 'd', context: 'ctx', consequences: '- c',
      },
    }];
    expect(() => parseRecordDecisions(JSON.stringify(bad))).toThrow();
  });

  it('drops an extra link that has a type but no target, keeping the record valid', () => {
    const decisions = [{
      learning: 'over-eager edge with no target',
      decision: {
        kind: 'create',
        title: 'Sanitized', type: 'process', topic: 'journal-engine', tags: ['t'],
        links: [{ type: 'relates' }, { type: 'relates', target: '0002' }],
        status: 'adopted', description: 'd', context: 'ctx', consequences: '- c',
      },
    }];
    const parsed = parseRecordDecisions(JSON.stringify(decisions));
    expect(parsed).toHaveLength(1);
    const decision = parsed[0]?.decision as { kind: string; links: Array<{ type: string; target: string }> };
    // The targetless link is dropped; only the well-formed one survives.
    expect(decision.links).toEqual([{ type: 'relates', target: '0002' }]);
  });

  it('accepts the legacy `to` spelling as an alias for `target`', () => {
    const decisions = [{
      learning: 'legacy to alias',
      decision: {
        kind: 'create',
        title: 'Aliased', type: 'process', topic: 'journal-engine', tags: ['t'],
        links: [{ type: 'depends-on', to: '0007' }],
        status: 'adopted', description: 'd', context: 'ctx', consequences: '- c',
      },
    }];
    const parsed = parseRecordDecisions(JSON.stringify(decisions));
    const decision = parsed[0]?.decision as { links: Array<{ type: string; target: string }> };
    expect(decision.links).toEqual([{ type: 'depends-on', target: '0007' }]);
  });

  it('drops a link whose type is not one of the 6 valid edge types', () => {
    const decisions = [{
      learning: 'bogus edge type',
      decision: {
        kind: 'create',
        title: 'Bogus edge', type: 'process', topic: 'journal-engine', tags: ['t'],
        links: [{ type: 'invented-edge', target: '0002' }, { type: 'parent', target: '0003' }],
        status: 'adopted', description: 'd', context: 'ctx', consequences: '- c',
      },
    }];
    const parsed = parseRecordDecisions(JSON.stringify(decisions));
    const decision = parsed[0]?.decision as { links: Array<{ type: string; target: string }> };
    expect(decision.links).toEqual([{ type: 'parent', target: '0003' }]);
  });

  it('accepts a create decision with links omitted (defaults to [])', () => {
    const decisions = [{
      learning: 'no links field at all',
      decision: {
        kind: 'create',
        title: 'No links', type: 'process', topic: 'journal-engine', tags: ['t'],
        status: 'adopted', description: 'd', context: 'ctx', consequences: '- c',
      },
    }];
    const parsed = parseRecordDecisions(JSON.stringify(decisions));
    const decision = parsed[0]?.decision as { links: Array<{ type: string; target: string }> };
    expect(decision.links).toEqual([]);
  });

  it('accepts refine/supersede decisions that include targetNodeId', () => {
    const good = [
      {
        learning: 'refine with target',
        decision: {
          kind: 'refine', targetNodeId: '0001',
          title: 'Refined', type: 'process', topic: 'journal-engine', tags: ['t'], links: [],
          status: 'adopted', description: 'd', context: 'ctx', consequences: '- c',
        },
      },
      {
        learning: 'supersede with target',
        decision: {
          kind: 'supersede', targetNodeId: '0001',
          title: 'Superseding', type: 'process', topic: 'journal-engine', tags: ['t'], links: [],
          status: 'adopted', description: 'd', context: 'ctx', consequences: '- c',
        },
      },
    ];
    const parsed = parseRecordDecisions(JSON.stringify(good));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.decision.kind).toBe('refine');
    expect(parsed[1]?.decision.kind).toBe('supersede');
  });

  it('record implement prompt emits decisions and stops writing files directly', () => {
    const implement = readFileSync(resolve('packages/core/src/skills/journal_record/implement.md'), 'utf8');
    expect(implement).toContain('emit a structured per-record decision');
    expect(implement).toContain('Do not write journal files yourself');
    expect(implement).toContain('candidatesByRecord');
    // The implementer no longer writes catalog/log files itself.
    expect(implement).not.toContain('Update `log.md` and `index.md`');
  });

  it('record review prompt verifies the APPLIED result and never writes files', () => {
    const review = readFileSync(resolve('packages/core/src/skills/journal_record/review.md'), 'utf8');
    expect(review).toContain('APPLIED');
    expect(review).toContain('recorded');
    expect(review).toContain('failed');
    // The reviewer verifies the applied result; it does not re-apply the decision list or write nodes.
    expect(review).toContain('review the decision list');
    expect(review).not.toContain('Write node files');
  });
});
