import { describe, it, expect } from 'vitest';
import { parseReviewerFindings } from '../../packages/core/src/review/parse-reviewer-findings.js';

const WORKER_OUTPUT = `I identified several issues in the codebase.

First, there is a critical SQL injection vulnerability in src/db/query.ts at line 42 where user input is directly concatenated into the query string. The pattern \`\`\`const q = "SELECT * FROM users WHERE id = " + req.params.id\`\`\` is dangerous.

Second, the authentication middleware in src/auth/login.ts:89 has an unguarded property access against undefined req.body.user, which will crash the server if the request body is missing the user field.

Third, the error handler in src/errors/handler.ts swallows all exceptions silently without logging, which means production incidents will have no diagnostic information.`;

const VALID_FINDINGS = [
  {
    id: 'F1',
    severity: 'critical' as const,
    claim: 'SQL injection in query builder',
    evidence: 'const q = "SELECT * FROM users WHERE id = " + req.params.id',
    reviewerConfidence: 95,
  },
  {
    id: 'F2',
    severity: 'high' as const,
    claim: 'Unguarded property access in auth middleware',
    evidence: 'src/auth/login.ts:89 has an unguarded property access against undefined req.body.user',
    reviewerConfidence: 85,
    suggestion: 'Use optional chaining or a guard clause',
  },
  {
    id: 'F3',
    severity: 'medium' as const,
    claim: 'Error handler swallows exceptions silently',
    evidence: 'the error handler in src/errors/handler.ts swallows all exceptions silently without logging',
    reviewerConfidence: 70,
  },
];

describe('parseReviewerFindings', () => {
  it('parses a valid findings array and annotates evidenceGrounded', () => {
    const json = JSON.stringify(VALID_FINDINGS);
    const reviewerOutput = `Review complete.\n\n\`\`\`json\n${json}\n\`\`\`\n\nAll findings documented.`;
    const result = parseReviewerFindings(reviewerOutput, WORKER_OUTPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.findings).toHaveLength(3);
    expect(result.ungroundedCount).toBe(0);

    expect(result.findings[0].id).toBe('F1');
    expect(result.findings[0].severity).toBe('critical');
    expect(result.findings[0].evidenceGrounded).toBe(true);

    expect(result.findings[1].id).toBe('F2');
    expect(result.findings[1].evidenceGrounded).toBe(true);
    expect(result.findings[1].suggestion).toBe('Use optional chaining or a guard clause');

    expect(result.findings[2].id).toBe('F3');
    expect(result.findings[2].evidenceGrounded).toBe(true);
  });

  it('returns error when reviewer output has no json block', () => {
    const result = parseReviewerFindings('Just some prose, no fence.', WORKER_OUTPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/missing.*```json/);
  });

  it('returns error when json block contains malformed JSON', () => {
    const result = parseReviewerFindings('```json\n{not valid json}\n```', WORKER_OUTPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/JSON parse failed/);
  });

  it('returns error when json fails schema validation', () => {
    const result = parseReviewerFindings(
      '```json\n[{"id":"F1","severity":"INVALID","claim":"x","evidence":"not long enough"}]\n```',
      WORKER_OUTPUT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/validation failed/);
  });

  it('returns error on duplicate finding ids', () => {
    const dupes = JSON.stringify([
      { id: 'F1', severity: 'high', claim: 'a', evidence: VALID_FINDINGS[0].evidence, reviewerConfidence: 80 },
      { id: 'F1', severity: 'medium', claim: 'b', evidence: VALID_FINDINGS[0].evidence, reviewerConfidence: 70 },
    ]);
    const result = parseReviewerFindings(`\`\`\`json\n${dupes}\n\`\`\``, WORKER_OUTPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/duplicate/);
  });

  it('returns error when reviewerConfidence is out of range', () => {
    const bad = JSON.stringify([
      { id: 'F1', severity: 'high', claim: 'a', evidence: VALID_FINDINGS[0].evidence, reviewerConfidence: 150 },
    ]);
    const result = parseReviewerFindings(`\`\`\`json\n${bad}\n\`\`\``, WORKER_OUTPUT);
    expect(result.ok).toBe(false);
  });

  it('flags findings with evidence not grounded in worker output', () => {
    const fabricated = JSON.stringify([
      {
        id: 'F1',
        severity: 'high' as const,
        claim: 'Fabricated issue not present in worker output',
        evidence: 'this exact sentence does not appear anywhere in the worker output text',
        reviewerConfidence: 90,
      },
    ]);
    const result = parseReviewerFindings(`\`\`\`json\n${fabricated}\n\`\`\``, WORKER_OUTPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidenceGrounded).toBe(false);
    expect(result.ungroundedCount).toBe(1);
  });

  it('accepts evidence with whitespace differences (normalized match)', () => {
    const withExtraSpaces = JSON.stringify([
      {
        id: 'F1',
        severity: 'high' as const,
        claim: 'SQL injection',
        evidence: 'const   q  =  "SELECT * FROM users WHERE id = "  +  req.params.id',
        reviewerConfidence: 90,
      },
    ]);
    const result = parseReviewerFindings(`\`\`\`json\n${withExtraSpaces}\n\`\`\``, WORKER_OUTPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings[0].evidenceGrounded).toBe(true);
  });

  it('accepts an empty findings array', () => {
    const result = parseReviewerFindings('```json\n[]\n```', WORKER_OUTPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toEqual([]);
    expect(result.ungroundedCount).toBe(0);
  });

  it('rejects evidence shorter than 20 chars at schema level', () => {
    const shortEvidence = JSON.stringify([
      {
        id: 'F1',
        severity: 'low' as const,
        claim: 'Short evidence',
        evidence: 'src/db/query.ts',
        reviewerConfidence: 50,
      },
    ]);
    const result = parseReviewerFindings(`\`\`\`json\n${shortEvidence}\n\`\`\``, WORKER_OUTPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/validation failed/);
  });

  it('extracts the last json block when multiple are present', () => {
    const firstBlock = JSON.stringify([{ id: 'FX', severity: 'low', claim: 'first', evidence: VALID_FINDINGS[0].evidence, reviewerConfidence: 50 }]);
    const secondBlock = JSON.stringify(VALID_FINDINGS);
    const reviewerOutput = `Example:\n\`\`\`json\n${firstBlock}\n\`\`\`\n\nReal findings:\n\`\`\`json\n${secondBlock}\n\`\`\``;
    const result = parseReviewerFindings(reviewerOutput, WORKER_OUTPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(3);
  });

  it('handles permissive fence: no newline after opening fence', () => {
    const json = JSON.stringify(VALID_FINDINGS);
    const result = parseReviewerFindings(`\`\`\`json${json}\n\`\`\``, WORKER_OUTPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(3);
  });

  it('handles permissive fence: compact closing', () => {
    const json = JSON.stringify(VALID_FINDINGS);
    const result = parseReviewerFindings(`\`\`\`json\n${json}\`\`\``, WORKER_OUTPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(3);
  });

  it('is case-insensitive on the json fence tag', () => {
    const json = JSON.stringify(VALID_FINDINGS);
    const result = parseReviewerFindings(`\`\`\`JSON\n${json}\n\`\`\``, WORKER_OUTPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(3);
  });
});
