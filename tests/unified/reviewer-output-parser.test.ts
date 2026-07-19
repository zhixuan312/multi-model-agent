import { describe, it, expect } from 'vitest';
import { parseReviewerOutput } from '../../packages/core/src/unified/reviewer-output-parser.js';

const VALID_AUDIT = JSON.stringify({
  criteriaCovered: ['scope-explicitness'],
  findings: [{ weight: 'high', category: 'scope-explicitness', claim: 'Missing scope', evidence: 'Section 2 lacks boundary', suggestion: 'Add scope section' }],
});

const VALID_INVESTIGATE = JSON.stringify({
  answer: 'X does Y per file.ts:10',
  criteriaCovered: ['direct-symbol-trace'],
  findings: [{ weight: 'high', category: 'direct-symbol-trace', claim: 'X does Y', evidence: 'function X()', file: 'file.ts', line: 10 }],
});

const VALID_DELEGATE = JSON.stringify({
  status: 'done', notes: 'All good',
});

const VALID_EXECUTE_PLAN = JSON.stringify({
  tasks: [{ title: 'Add error handler', status: 'done' }],
  notes: 'Applied verbatim',
});

const VALID_REVIEW = JSON.stringify({
  criteriaCovered: ['test-gap'],
  findings: [{ weight: 'high', category: 'test-gap', claim: 'No tests for X', evidence: 'function X()', file: 'src/x.ts', line: 5, suggestion: 'Add test', preExisting: false }],
});

const VALID_DEBUG = JSON.stringify({
  answer: 'Root cause: off-by-one in loop',
  criteriaCovered: ['symptom-location'],
  findings: [{ weight: 'critical', category: 'symptom-location', claim: 'Crash at line 42', evidence: 'arr[i+1]', file: 'src/loop.ts', line: 42 }],
});

const VALID_RESEARCH = JSON.stringify({
  answer: 'The consensus is to use approach X',
  criteriaCovered: ['primary-sources'],
  findings: [{ weight: 'high', category: 'primary-sources', claim: 'Paper describes X', evidence: 'Section 3.2', url: 'https://arxiv.org/abs/2024.1234', source: 'arxiv' }],
});

const VALID_JOURNAL_RECALL = JSON.stringify({
  answer: 'Prior decision: use sequential dispatch',
  criteriaCovered: ['decision'],
  findings: [{
    weight: 'high',
    category: 'decision',
    claim: 'Sequential chosen over parallel',
    evidence: 'Node 0012 relates to 0008',
    topic: 'dispatch-runtime',
    fallback: false,
    nodeId: '0012',
    nodePath: '.mma/journal/nodes/0012-dispatch-order.md',
  }],
});

const VALID_JOURNAL_RECORD = JSON.stringify({
  recorded: [{
    learning: 'Haiku cannot verify citations',
    type: 'process',
    topic: 'citation-verification',
    nodeId: '0015',
    nodePath: '.mma/journal/nodes/0015-refiner-limitation.md',
  }],
  failed: [],
});

const LEGACY_CRITIC = JSON.stringify({
  findings: [{ severity: 'high', category: 'bug', description: 'off by one', location: 'f.ts:10', fix: 'applied' }],
  summary: 'fixed',
  verdict: 'changes_made',
});

describe('parseReviewerOutput', () => {
  describe('JSON extraction', () => {
    it('extracts fenced JSON', () => {
      const r = parseReviewerOutput(`text\n\`\`\`json\n${VALID_AUDIT}\n\`\`\`\nmore`, 'audit');
      expect(r.ok).toBe(true);
    });

    it('extracts bare JSON', () => {
      const r = parseReviewerOutput(VALID_AUDIT, 'audit');
      expect(r.ok).toBe(true);
    });

    it('extracts LAST fenced JSON when multiple blocks present (draft + final)', () => {
      const draft = JSON.stringify({ criteriaCovered: ['x'], findings: [{ weight: 'low', category: 'x', claim: 'draft', evidence: 'e', suggestion: 's' }] });
      const final = JSON.stringify({ criteriaCovered: ['scope-explicitness'], findings: [{ weight: 'high', category: 'scope-explicitness', claim: 'real finding', evidence: 'quoted text', suggestion: 'fix it' }] });
      const output = `Verification narrative...\n\`\`\`json\n${draft}\n\`\`\`\nAll verified.\n\`\`\`json\n${final}\n\`\`\``;
      const r = parseReviewerOutput(output, 'audit');
      expect(r.ok).toBe(true);
      if (r.ok) {
        const data = r.data as { findings: { claim: string }[] };
        expect(data.findings[0].claim).toBe('real finding');
      }
    });

    it('fails on prose-only output', () => {
      const r = parseReviewerOutput('Looks fine to me.', 'audit');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('No JSON found');
    });
  });

  describe('per-type schema validation', () => {
    it('validates audit output against audit schema', () => {
      const r = parseReviewerOutput(VALID_AUDIT, 'audit');
      expect(r.ok).toBe(true);
      if (r.ok) {
        const data = r.data as { criteriaCovered: string[]; findings: unknown[] };
        expect(data.criteriaCovered).toContain('scope-explicitness');
        expect(data.findings).toHaveLength(1);
      }
    });

    it('validates investigate output against investigate schema', () => {
      const r = parseReviewerOutput(VALID_INVESTIGATE, 'investigate');
      expect(r.ok).toBe(true);
      if (r.ok) {
        const data = r.data as { answer: string; criteriaCovered: string[] };
        expect(data.answer).toBe('X does Y per file.ts:10');
        expect(data.criteriaCovered).toContain('direct-symbol-trace');
      }
    });

    it('validates delegate output against delegate schema', () => {
      const r = parseReviewerOutput(VALID_DELEGATE, 'delegate');
      expect(r.ok).toBe(true);
      if (r.ok) {
        const data = r.data as { status: string };
        expect(data.status).toBe('done');
      }
    });

    it('validates execute_plan output', () => {
      const r = parseReviewerOutput(VALID_EXECUTE_PLAN, 'execute_plan');
      expect(r.ok).toBe(true);
      if (r.ok) {
        const data = r.data as { tasks: { title: string; status: string }[] };
        expect(data.tasks).toHaveLength(1);
        expect(data.tasks[0].status).toBe('done');
      }
    });

    it('validates review output', () => {
      const r = parseReviewerOutput(VALID_REVIEW, 'review');
      expect(r.ok).toBe(true);
      if (r.ok) {
        const data = r.data as { criteriaCovered: string[]; findings: { preExisting: boolean }[] };
        expect(data.criteriaCovered).toContain('test-gap');
        expect(data.findings[0].preExisting).toBe(false);
      }
    });

    it('validates debug output', () => {
      const r = parseReviewerOutput(VALID_DEBUG, 'debug');
      expect(r.ok).toBe(true);
      if (r.ok) {
        const data = r.data as { answer: string; findings: { file: string }[] };
        expect(data.answer).toContain('off-by-one');
        expect(data.findings[0].file).toBe('src/loop.ts');
      }
    });

    it('validates research output', () => {
      const r = parseReviewerOutput(VALID_RESEARCH, 'research');
      expect(r.ok).toBe(true);
      if (r.ok) {
        const data = r.data as { findings: { url: string; source: string }[] };
        expect(data.findings[0].url).toContain('arxiv.org');
        expect(data.findings[0].source).toBe('arxiv');
      }
    });

    it('validates journal_recall output', () => {
      const r = parseReviewerOutput(VALID_JOURNAL_RECALL, 'journal_recall');
      expect(r.ok).toBe(true);
      if (r.ok) {
        const data = r.data as { findings: { topic: string; fallback: boolean; nodeId: string; nodePath: string }[] };
        expect(data.findings[0].topic).toBe('dispatch-runtime');
        expect(data.findings[0].fallback).toBe(false);
        expect(data.findings[0].nodeId).toBe('0012');
        expect(data.findings[0].nodePath).toContain('.mma/journal');
      }
    });

    it('rejects journal_recall output without topic', () => {
      const r = parseReviewerOutput(JSON.stringify({
        answer: 'Prior decision: use sequential dispatch',
        criteriaCovered: ['decision'],
        findings: [{
          weight: 'high',
          category: 'decision',
          claim: 'Sequential chosen over parallel',
          evidence: 'Node 0012 relates to 0008',
          fallback: false,
          nodeId: '0012',
          nodePath: '.mma/journal/nodes/0012-dispatch-order.md',
        }],
      }), 'journal_recall');
      expect(r.ok).toBe(false);
    });

    it('rejects journal_recall output without fallback', () => {
      const r = parseReviewerOutput(JSON.stringify({
        answer: 'Prior decision: use sequential dispatch',
        criteriaCovered: ['decision'],
        findings: [{
          weight: 'high',
          category: 'decision',
          claim: 'Sequential chosen over parallel',
          evidence: 'Node 0012 relates to 0008',
          topic: 'dispatch-runtime',
          nodeId: '0012',
          nodePath: '.mma/journal/nodes/0012-dispatch-order.md',
        }],
      }), 'journal_recall');
      expect(r.ok).toBe(false);
    });

    it('validates journal_record output', () => {
      const r = parseReviewerOutput(VALID_JOURNAL_RECORD, 'journal_record');
      expect(r.ok).toBe(true);
      if (r.ok) {
        const data = r.data as { recorded: { topic: string; nodeId: string }[]; failed: unknown[] };
        expect(data.recorded).toHaveLength(1);
        expect(data.recorded[0].topic).toBe('citation-verification');
        expect(data.failed).toHaveLength(0);
      }
    });

    it('rejects journal_record output without topic', () => {
      const r = parseReviewerOutput(JSON.stringify({
        recorded: [{
          learning: 'Haiku cannot verify citations',
          type: 'process',
          nodeId: '0015',
          nodePath: '.mma/journal/nodes/0015-refiner-limitation.md',
        }],
        failed: [],
      }), 'journal_record');
      expect(r.ok).toBe(false);
    });

    it('rejects wrong-type output (audit JSON against investigate schema)', () => {
      const r = parseReviewerOutput(VALID_AUDIT, 'investigate');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('Schema');
    });

    it('rejects legacy critic format for typed task types', () => {
      const r = parseReviewerOutput(LEGACY_CRITIC, 'audit');
      expect(r.ok).toBe(false);
    });

    it('rejects invalid enum values', () => {
      const bad = JSON.stringify({
        criteriaCovered: ['x'],
        findings: [{ weight: 'maybe', category: 'x', claim: 'y', evidence: 'z', suggestion: 'w' }],
      });
      const r = parseReviewerOutput(bad, 'audit');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('Schema');
    });

    it('accepts all four weight values: critical, high, medium, low', () => {
      for (const w of ['critical', 'high', 'medium', 'low']) {
        const data = JSON.stringify({
          criteriaCovered: ['x'],
          findings: [{ weight: w, category: 'x', claim: 'y', evidence: 'z', suggestion: 'w' }],
        });
        const r = parseReviewerOutput(data, 'audit');
        expect(r.ok, `weight=${w} should be accepted`).toBe(true);
      }
    });

    it('rejects missing required fields', () => {
      const partial = JSON.stringify({ criteriaCovered: ['x'] });
      const r = parseReviewerOutput(partial, 'audit');
      expect(r.ok).toBe(false);
    });

    it('accepts empty findings array', () => {
      const clean = JSON.stringify({
        criteriaCovered: ['all'], findings: [],
      });
      const r = parseReviewerOutput(clean, 'audit');
      expect(r.ok).toBe(true);
    });
  });

  describe('untyped task types', () => {
    it('orchestrate accepts any valid JSON', () => {
      const r = parseReviewerOutput('{"result": "ok"}', 'orchestrate');
      expect(r.ok).toBe(true);
    });
  });
});
