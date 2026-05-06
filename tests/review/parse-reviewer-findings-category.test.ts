import { describe, it, expect } from 'vitest';
import { parseReviewerFindings } from '../../packages/core/src/review/parse-reviewer-findings.js';

const WORKER_OUTPUT = `
The handler reads the user input directly:

  router.get('/admin', adminHandler) — no auth middleware applied
  shellExec(req.body.cmd)

Both are problematic.
`.trim();

function reviewerOutputWith(json: string): string {
  return `Some preamble.\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

describe('parseReviewerFindings — per-finding category', () => {
  it('preserves a reviewer-emitted category', () => {
    const json = JSON.stringify([{
      id: 'F1',
      severity: 'medium',
      claim: 'Auth check missing on /admin endpoint',
      evidence: "router.get('/admin', adminHandler) — no auth middleware applied",
      annotatorConfidence: 60,
      category: 'security',
    }]);
    const r = parseReviewerFindings(reviewerOutputWith(json), WORKER_OUTPUT);
    if (!r.ok) throw new Error(`parse failed: ${r.reason}`);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.category).toBe('security');
  });

  it('falls back to classifyConcern(claim) when the reviewer omits category', () => {
    const json = JSON.stringify([{
      id: 'F1',
      severity: 'low',
      claim: 'No unit tests cover the new branch',
      evidence: "router.get('/admin', adminHandler) — no auth middleware applied",
      annotatorConfidence: 50,
    }]);
    const r = parseReviewerFindings(reviewerOutputWith(json), WORKER_OUTPUT);
    if (!r.ok) throw new Error(`parse failed: ${r.reason}`);
    expect(r.findings[0]!.category).toBe('missing_test');
  });

  it('falls back to "other" when no pattern matches', () => {
    const json = JSON.stringify([{
      id: 'F1',
      severity: 'low',
      claim: 'A generic statement that matches nothing in particular',
      evidence: "router.get('/admin', adminHandler) — no auth middleware applied",
      annotatorConfidence: 30,
    }]);
    const r = parseReviewerFindings(reviewerOutputWith(json), WORKER_OUTPUT);
    if (!r.ok) throw new Error(`parse failed: ${r.reason}`);
    expect(r.findings[0]!.category).toBe('other');
  });
});
