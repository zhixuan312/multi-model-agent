import { describe, it, expect } from 'vitest';
import { fallbackExtractFindings } from '../../packages/core/src/review/fallback-extraction.js';
import { annotatedFindingsSchema } from '../../packages/core/src/executors/_shared/findings-schema.js';

function expectSchemaValid(out: unknown) {
  const r = annotatedFindingsSchema.safeParse(out);
  if (!r.success) throw new Error(`fallback output violates schema: ${r.error.message}`);
  expect(r.success).toBe(true);
}

describe('fallbackExtractFindings', () => {
  it('extracts numbered ### sections with severity', () => {
    const worker = `
### 1. SQL Injection in login handler
Severity: high

The login handler concatenates user input directly into a SQL query
without parameterization. This allows an attacker to bypass authentication.

### 2. Missing rate limiting on API
Severity: medium

Rate limiting middleware is commented out.

### 3. Hardcoded secret in config
Severity: critical

The JWT secret is hardcoded in config.ts line 42.
`;
    const result = fallbackExtractFindings(worker);
    expectSchemaValid(result);
    expect(result).toHaveLength(3);

    expect(result[0]!.id).toBe('F1');
    expect(result[0]!.severity).toBe('high');
    expect(result[0]!.claim).toContain('SQL Injection');
    expect(result[0]!.evidenceGrounded).toBe(true);
    expect(result[0]!.reviewerConfidence).toBeNull();

    expect(result[1]!.id).toBe('F2');
    expect(result[1]!.severity).toBe('medium');

    expect(result[2]!.id).toBe('F3');
    expect(result[2]!.severity).toBe('critical');

    // All ids must be unique
    const ids = result.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('handles "mid" as medium severity', () => {
    const worker = `
### 1. Slow query
Severity: mid

The N+1 query pattern in getOrders.
`;
    const result = fallbackExtractFindings(worker);
    expectSchemaValid(result);
    expect(result[0]!.severity).toBe('medium');
  });

  it('handles bracketed numbering: [N] form', () => {
    const worker = `
### [1] Unvalidated redirect
Severity: high

After login, the redirect URL is not validated against a whitelist.
`;
    const result = fallbackExtractFindings(worker);
    expectSchemaValid(result);
    expect(result).toHaveLength(1);
    expect(result[0]!.claim).toContain('Unvalidated redirect');
    expect(result[0]!.severity).toBe('high');
  });

  it('handles "Finding N — Title" form', () => {
    const worker = `
### Finding 1 — Missing input validation
Severity: high

User input is not sanitized before rendering in the dashboard.
`;
    const result = fallbackExtractFindings(worker);
    expectSchemaValid(result);
    expect(result).toHaveLength(1);
    expect(result[0]!.claim).toBe('Missing input validation');
  });

  it('handles h4 headings with colon', () => {
    const worker = `
#### 1: Race condition in payment flow
Severity: high

Concurrent requests can cause double-charge.
`;
    const result = fallbackExtractFindings(worker);
    expectSchemaValid(result);
    expect(result[0]!.claim).toBe('Race condition in payment flow');
  });

  it('defaults to medium severity when Severity line is missing', () => {
    const worker = `
### 1. Some observation

Just a general note without a severity line.
`;
    const result = fallbackExtractFindings(worker);
    expectSchemaValid(result);
    expect(result[0]!.severity).toBe('medium');
  });

  it('defaults to medium severity on unknown severity value', () => {
    const worker = `
### 1. Unknown severity
Severity: catastrophic

This has a made-up severity label.
`;
    const result = fallbackExtractFindings(worker);
    expectSchemaValid(result);
    expect(result[0]!.severity).toBe('medium');
  });

  it('returns empty array on explicit "no findings" language', () => {
    const worker = 'No findings detected in this codebase. All checks passed.';
    const result = fallbackExtractFindings(worker);
    expect(result).toEqual([]);
  });

  it('returns empty array on "0 findings" output', () => {
    const worker = '## Review Summary\n\nNothing to report. 0 findings.';
    const result = fallbackExtractFindings(worker);
    expect(result).toEqual([]);
  });

  it('returns catch-all finding for unstructured output', () => {
    const worker = 'Everything looks fine to me, ship it.';
    const result = fallbackExtractFindings(worker);
    expectSchemaValid(result);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('F1');
    expect(result[0]!.severity).toBe('medium');
    expect(result[0]!.reviewerConfidence).toBeNull();
    expect(result[0]!.evidenceGrounded).toBe(true);
  });

  it('returns catch-all with evidenceGrounded=false for very short output', () => {
    const worker = 'OK';
    const result = fallbackExtractFindings(worker);
    expectSchemaValid(result);
    expect(result).toHaveLength(1);
    expect(result[0]!.evidenceGrounded).toBe(false);
  });

  it('ignores structural headings like Summary and Performance', () => {
    const worker = `
### Summary
This is an overview.

### Performance Notes
Things are fast.

### 1. Actual finding
Severity: low

A real issue.
`;
    const result = fallbackExtractFindings(worker);
    expectSchemaValid(result);
    expect(result).toHaveLength(1);
    expect(result[0]!.claim).toBe('Actual finding');
    expect(result[0]!.severity).toBe('low');
  });

  it('uses section body for evidence when available', () => {
    const worker = `
### 1. Auth bypass
Severity: critical

The middleware skips authentication when the request header X-Debug is set to true.
This allows anyone with knowledge of the header to access admin endpoints.
`;
    const result = fallbackExtractFindings(worker);
    expectSchemaValid(result);
    expect(result[0]!.evidence).toContain('middleware skips authentication');
    expect(result[0]!.evidence.length).toBeLessThanOrEqual(240);
    expect(result[0]!.evidenceGrounded).toBe(true);
  });

  it('uses ids F1, F2, ... regardless of worker numbering', () => {
    const worker = `
### [42] Remote code execution
Severity: critical

eval() is used on user-supplied input.

### [99] XSS in comment form
Severity: low

Comments are rendered without escaping.
`;
    const result = fallbackExtractFindings(worker);
    expectSchemaValid(result);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('F1');
    expect(result[1]!.id).toBe('F2');
    // Ensure worker numbers are NOT used as ids
    expect(result[0]!.id).not.toBe('F42');
    expect(result[1]!.id).not.toBe('F99');
  });

  it('handles multiple sections with different heading levels', () => {
    const worker = `
## 1. High-level architecture concern
Severity: medium

The service is tightly coupled.

### 2. Specific bug
Severity: high

Null pointer in the parser.

#### 3. Minor style issue
Severity: low

Missing semicolon.
`;
    const result = fallbackExtractFindings(worker);
    expectSchemaValid(result);
    expect(result).toHaveLength(3);
    expect(result.map(f => f.severity)).toEqual(['medium', 'high', 'low']);
  });

  it('handles empty string gracefully', () => {
    const result = fallbackExtractFindings('');
    expectSchemaValid(result);
    expect(result).toHaveLength(1);
    expect(result[0]!.evidenceGrounded).toBe(false);
  });
});
