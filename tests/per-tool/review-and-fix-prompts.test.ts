import { describe, it, expect } from 'vitest';
import { specReviewAndFixTemplate } from '../../packages/core/src/review/templates/spec-review-and-fix.js';
import { qualityReviewAndFixTemplate } from '../../packages/core/src/review/templates/quality-review-and-fix.js';
import { annotateCompletionTemplate } from '../../packages/core/src/review/templates/annotate-completion.js';

describe('spec-review-and-fix template', () => {
  it('system prompt instructs to fix inline, not just report', () => {
    const sys = specReviewAndFixTemplate.systemPrompt;
    expect(sys).toMatch(/fix.*directly|apply.*patches|using.*editor tools/i);
    expect(sys).toMatch(/do not just report/i);
  });

  it('user prompt includes plan + diff + worker summary', () => {
    const out = specReviewAndFixTemplate.buildUserPrompt({
      brief: 'task brief',
      workerOutput: 'worker said done',
      diff: '@@ -1,1 +1,1 @@\n+x',
      planContext: '# plan section',
    });
    expect(out).toContain('# plan section');
    expect(out).toContain('+x');
    expect(out).toContain('worker said done');
  });
});

describe('quality-review-and-fix template', () => {
  it('system prompt covers safety + correctness lenses', () => {
    const sys = qualityReviewAndFixTemplate.systemPrompt;
    expect(sys).toMatch(/safety|correctness|error handling|security/i);
    expect(sys).toMatch(/fix.*directly|apply.*patches|fix any risk/i);
  });

  it('reads spec reviewer summary from priorConcerns', () => {
    const out = qualityReviewAndFixTemplate.buildUserPrompt({
      brief: 'b',
      workerOutput: '',
      diff: '@@ +x',
      priorConcerns: ['spec said all good'],
    });
    expect(out).toContain('spec said all good');
  });
});

describe('annotate-completion template', () => {
  it('system prompt requires fenced json block output', () => {
    const sys = annotateCompletionTemplate.systemPrompt;
    expect(sys).toContain('```json');
    expect(sys).toMatch(/single.*fenced.*block|no prose/i);
  });

  it('user prompt includes plan section + final diff + reviewer notes + verify result', () => {
    const out = annotateCompletionTemplate.buildUserPrompt({
      brief: 'task brief',
      workerOutput: '',
      diff: '@@ -1,1 +1,1 @@\n+x',
      planContext: '# plan',
      specReviewerNotes: 'spec notes',
      qualityReviewerNotes: 'quality notes',
      verifyResult: { ran: true, passed: true, exitCode: 0, command: ['npm', 'test'], tailOutput: 'PASS' },
    });
    expect(out).toContain('# plan');
    expect(out).toContain('+x');
    expect(out).toContain('spec notes');
    expect(out).toContain('quality notes');
    expect(out).toContain('PASS');
  });

  it('user prompt handles missing reviewer notes gracefully', () => {
    const out = annotateCompletionTemplate.buildUserPrompt({
      brief: 'b',
      workerOutput: '',
      diff: '@@ +x',
    });
    expect(out).not.toContain('Spec reviewer');
    expect(out).not.toContain('Quality reviewer');
  });
});
