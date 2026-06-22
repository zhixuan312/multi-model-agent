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
    it('retry_tasks accepts any valid JSON', () => {
      const r = parseReviewerOutput('{"anything": true}', 'retry_tasks');
      expect(r.ok).toBe(true);
    });

    it('retry_tasks accepts legacy critic format', () => {
      const r = parseReviewerOutput(LEGACY_CRITIC, 'retry_tasks');
      expect(r.ok).toBe(true);
    });

    it('retry_tasks fails on non-JSON', () => {
      const r = parseReviewerOutput('just text', 'retry_tasks');
      expect(r.ok).toBe(false);
    });

    it('orchestrate accepts any valid JSON', () => {
      const r = parseReviewerOutput('{"result": "ok"}', 'orchestrate');
      expect(r.ok).toBe(true);
    });
  });
});
