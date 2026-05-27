import { describe, it, expect } from 'bun:test';
import { journalReviewPrompt } from '../../../packages/core/src/lifecycle/handlers/journal-review-prompt.js';
import { parseReviewReport } from '../../../packages/core/src/lifecycle/handlers/parse-review-report.js';

describe('journalReviewPrompt', () => {
  const ctx = {
    brief: 'record learning: divide() lacks a zero-divisor guard',
    workerSummary: 'created node 0001',
    filesChanged: ['.mmagent/journal/nodes/0001-x.md', '.mmagent/journal/index.md'],
    diff: '+ id: "0001"\n+ status: adopted',
  };

  it('validates the node (frontmatter/edges/schema/confinement/dedup), not code', () => {
    const p = journalReviewPrompt(ctx);
    expect(p).toMatch(/markdown ADR/i);
    expect(p).toMatch(/FRONTMATTER/);
    expect(p).toMatch(/supersedes, refines, relates, depends-on, contradicts, parent/);
    expect(p).toMatch(/\.mmagent\/journal\//);
    expect(p).toMatch(/not code|judge the node/i);
  });

  it('keeps Fix B diff-grounding + guardrails', () => {
    const p = journalReviewPrompt(ctx);
    expect(p).toContain('Diff (authoritative');
    expect(p).toMatch(/do NOT claim files are missing/i);
    const empty = journalReviewPrompt({ ...ctx, diff: '' });
    expect(empty).toContain('(no diff available)');
  });

  it('produces output the shared review parser understands (approved round-trips)', () => {
    // A reviewer following the format with an approved verdict must parse to approved.
    const reviewerSays = '## Verdict\napproved\n\n## Outcome\nclean';
    const parsed = parseReviewReport(reviewerSays);
    expect(parsed.verdict).toBe('approved');
    expect(parsed.findings).toHaveLength(0);
  });
});
