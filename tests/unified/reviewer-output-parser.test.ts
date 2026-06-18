import { describe, it, expect } from 'vitest';
import { parseReviewerOutput } from '../../packages/core/src/unified/reviewer-output-parser.js';

const VALID_AUDIT = JSON.stringify({
  findingsCount: 1,
  criteriaCovered: ['scope-explicitness'],
  overallAssessment: 'found',
  findings: [{ severity: 'high', category: 'scope-explicitness', claim: 'Missing scope', evidence: 'Section 2 lacks boundary', suggestion: 'Add scope section' }],
});

const VALID_INVESTIGATE = JSON.stringify({
  question: 'What does X do?',
  answer: 'X does Y per file.ts:10',
  citations: [{ file: 'file.ts', line: 10, content: 'function X()' }],
  confidence: 'high',
  negativeFindings: [],
  subAnswers: [{ perspective: 'direct', finding: 'X does Y', confidence: 'high' }],
});

const VALID_DELEGATE = JSON.stringify({
  tasksCompleted: ['Added comment'],
  filesChanged: ['a.ts'],
  workerSelfAssessment: 'done',
  notes: 'All good',
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
        const data = r.data as { findingsCount: number; overallAssessment: string };
        expect(data.findingsCount).toBe(1);
        expect(data.overallAssessment).toBe('found');
      }
    });

    it('validates investigate output against investigate schema', () => {
      const r = parseReviewerOutput(VALID_INVESTIGATE, 'investigate');
      expect(r.ok).toBe(true);
      if (r.ok) {
        const data = r.data as { question: string; confidence: string };
        expect(data.question).toBe('What does X do?');
        expect(data.confidence).toBe('high');
      }
    });

    it('validates delegate output against delegate schema', () => {
      const r = parseReviewerOutput(VALID_DELEGATE, 'delegate');
      expect(r.ok).toBe(true);
      if (r.ok) {
        const data = r.data as { workerSelfAssessment: string };
        expect(data.workerSelfAssessment).toBe('done');
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
        findingsCount: 0, criteriaCovered: ['x'], overallAssessment: 'maybe',
        findings: [],
      });
      const r = parseReviewerOutput(bad, 'audit');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('Schema');
    });

    it('rejects missing required fields', () => {
      const partial = JSON.stringify({ findingsCount: 0 });
      const r = parseReviewerOutput(partial, 'audit');
      expect(r.ok).toBe(false);
    });

    it('accepts empty arrays (zero findings)', () => {
      const clean = JSON.stringify({
        findingsCount: 0, criteriaCovered: ['all'], overallAssessment: 'clean', findings: [],
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

    it('main accepts any valid JSON', () => {
      const r = parseReviewerOutput('{"result": "ok"}', 'main');
      expect(r.ok).toBe(true);
    });
  });
});
