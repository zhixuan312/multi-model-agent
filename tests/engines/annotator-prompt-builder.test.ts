import { describe, it, expect } from 'vitest';
import { AnnotatorPromptBuilder } from '../../packages/core/src/engines/annotator-prompt-builder.js';
import { auditTemplate } from '../../packages/core/src/engines/annotator-templates/audit.js';
import { reviewTemplate } from '../../packages/core/src/engines/annotator-templates/review.js';
import { verifyTemplate } from '../../packages/core/src/engines/annotator-templates/verify.js';
import { debugTemplate } from '../../packages/core/src/engines/annotator-templates/debug.js';
import { investigateTemplate } from '../../packages/core/src/engines/annotator-templates/investigate.js';

describe('AnnotatorPromptBuilder', () => {
  const builder = new AnnotatorPromptBuilder({
    audit: auditTemplate,
    review: reviewTemplate,
    verify: verifyTemplate,
    debug: debugTemplate,
    investigate: investigateTemplate,
  });

  const sampleFindings = [
    { id: 'F1', severity: 'high', claim: 'SQL injection', evidence: 'query("SELECT * FROM " + userInput)' },
    { id: 'F2', severity: 'low', claim: 'Missing semicolon', evidence: 'const x = 1' },
  ];

  it('all 5 templates emphasize never-drop', () => {
    for (const kind of ['audit', 'review', 'verify', 'debug', 'investigate'] as const) {
      const p = builder.build(kind, { implFindings: sampleFindings });
      expect(p.toLowerCase()).toMatch(/never drop|preserve every|do not drop/);
    }
  });

  it('all 5 templates contain annotatorConfidence field rules', () => {
    for (const kind of ['audit', 'review', 'verify', 'debug', 'investigate'] as const) {
      const p = builder.build(kind, { implFindings: sampleFindings });
      expect(p).toContain('annotatorConfidence');
    }
  });

  it('all 5 templates require JSON output format', () => {
    for (const kind of ['audit', 'review', 'verify', 'debug', 'investigate'] as const) {
      const p = builder.build(kind, { implFindings: sampleFindings });
      expect(p).toContain('```json');
    }
  });

  it('all 5 templates include severity re-judgment instruction', () => {
    for (const kind of ['audit', 'review', 'verify', 'debug', 'investigate'] as const) {
      const p = builder.build(kind, { implFindings: sampleFindings });
      expect(p).toContain('RE-JUDGE');
    }
  });

  it('all 5 templates embed input findings as JSON', () => {
    for (const kind of ['audit', 'review', 'verify', 'debug', 'investigate'] as const) {
      const p = builder.build(kind, { implFindings: sampleFindings });
      expect(p).toContain('SQL injection');
      expect(p).toContain('F1');
    }
  });

  it('all 5 templates produce distinct output for same input', () => {
    const prompts = [
      builder.build('audit', { implFindings: sampleFindings }),
      builder.build('review', { implFindings: sampleFindings }),
      builder.build('verify', { implFindings: sampleFindings }),
      builder.build('debug', { implFindings: sampleFindings }),
      builder.build('investigate', { implFindings: sampleFindings }),
    ];
    const unique = new Set(prompts);
    expect(unique.size).toBe(5);
  });

  it('audit template includes security-audit context', () => {
    const p = builder.build('audit', { implFindings: sampleFindings });
    expect(p).toContain('security audit');
  });

  it('review template includes code-review context', () => {
    const p = builder.build('review', { implFindings: sampleFindings });
    expect(p).toContain('code review');
  });

  it('verify template includes checklist context', () => {
    const p = builder.build('verify', { implFindings: sampleFindings });
    expect(p).toContain('checklist');
  });

  it('debug template includes hypothesis context', () => {
    const p = builder.build('debug', { implFindings: sampleFindings });
    expect(p.toLowerCase()).toContain('hypothesis');
  });

  it('investigate template includes investigation context', () => {
    const p = builder.build('investigate', { implFindings: sampleFindings });
    expect(p).toContain('investigation');
  });

  it('build with empty findings still includes never-drop instruction', () => {
    for (const kind of ['audit', 'review', 'verify', 'debug', 'investigate'] as const) {
      const p = builder.build(kind, { implFindings: [] });
      expect(p.toLowerCase()).toMatch(/never drop|preserve every|do not drop/);
      expect(p).toContain('```json');
    }
  });
});
