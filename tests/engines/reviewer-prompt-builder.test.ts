import { describe, it, expect } from 'vitest';
import { ReviewerPromptBuilder } from '../../packages/core/src/engines/reviewer-prompt-builder.js';
import { specTemplate } from '../../packages/core/src/engines/reviewer-templates/spec.js';
import { qualityAPTemplate } from '../../packages/core/src/engines/reviewer-templates/quality-ap.js';
import { diffTemplate } from '../../packages/core/src/engines/reviewer-templates/diff.js';

describe('ReviewerPromptBuilder', () => {
  const builder = new ReviewerPromptBuilder({
    spec: specTemplate,
    qualityForAP: qualityAPTemplate,
    diff: diffTemplate,
  });

  it('builds spec prompt containing the brief', () => {
    const p = builder.buildSpec({ artifact: 'artifact-content', brief: 'spec-brief' });
    expect(p).toContain('spec-brief');
    expect(p).toContain('artifact-content');
    expect(p).toContain('spec compliance reviewer');
  });

  it('builds spec prompt with verdict instructions', () => {
    const p = builder.buildSpec({ artifact: 'x', brief: 'y' });
    expect(p).toContain('approved');
    expect(p).toContain('changes_required');
    expect(p).toContain('## Summary');
    expect(p).toContain('## Deviations from brief');
  });

  it('builds quality-ap prompt containing the brief', () => {
    const p = builder.buildQualityAP({ artifact: 'worker-output', brief: 'quality-brief' });
    expect(p).toContain('quality-brief');
    expect(p).toContain('worker-output');
    expect(p).toContain('audit-point');
  });

  it('builds quality-ap prompt with JSON output format', () => {
    const p = builder.buildQualityAP({ artifact: 'x', brief: 'y' });
    expect(p).toContain('```json');
    expect(p).toContain('annotatorConfidence');
    expect(p).toContain('F1');
    expect(p).toContain('severity');
  });

  it('builds quality-ap prompt distinct from spec', () => {
    const s = builder.buildSpec({ artifact: 'x', brief: 'B' });
    const q = builder.buildQualityAP({ artifact: 'x', brief: 'B' });
    expect(s).not.toBe(q);
  });

  it('builds diff prompt containing the diff artifact', () => {
    const p = builder.buildDiff({ artifact: '+added line\n-removed line', brief: 'verify refactor' });
    expect(p).toContain('+added line');
    expect(p).toContain('-removed line');
    expect(p).toContain('verify refactor');
  });

  it('builds diff prompt with APPROVE/CONCERNS/REJECT format', () => {
    const p = builder.buildDiff({ artifact: 'diff', brief: 'ctx' });
    expect(p).toContain('APPROVE');
    expect(p).toContain('CONCERNS');
    expect(p).toContain('REJECT');
    expect(p).toContain('mechanical refactor');
  });

  it('all three templates produce distinct output for same input', () => {
    const input = { artifact: 'test-artifact', brief: 'test-brief' };
    const s = builder.buildSpec(input);
    const q = builder.buildQualityAP(input);
    const d = builder.buildDiff(input);
    expect(s).not.toBe(q);
    expect(q).not.toBe(d);
    expect(s).not.toBe(d);
  });
});
