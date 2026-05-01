import { describe, it, expect, vi } from 'vitest';
import { runQualityReview } from '../../packages/core/src/review/quality-reviewer.js';
import { buildAuditQualityPrompt } from '../../packages/core/src/review/quality-only-prompts.js';
import type { Provider } from '../../packages/core/src/types.js';
import type { RunResult } from '../../packages/core/src/types.js';
import type { RunOptions } from '../../packages/core/src/runners/types.js';
import type { ParsedStructuredReport } from '../../packages/core/src/reporting/structured-report.js';

const fakeReport: ParsedStructuredReport = {
  summary: 'approved',
  filesChanged: [],
  validationsRun: [],
  deviationsFromBrief: [],
  unresolved: [],
  extraSections: {},
};

function makeOkResult(output: string): RunResult {
  return {
    output,
    status: 'ok',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
    turns: 1,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [],
  };
}

function makeErrorResult(status: 'error' | 'api_error' | 'network_error' | 'timeout' | 'api_aborted'): RunResult {
  return {
    output: '',
    status,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
    turns: 0,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: true,
    escalationLog: [],
  };
}

function makeProvider(
  behavior: (prompt: string, signal?: AbortSignal, timeoutMs?: number) => Promise<RunResult>,
): Provider {
  return {
    name: 'standard',
    config: { type: 'openai-compatible', model: 'mock', baseUrl: 'mock' } as any,
    run: async (prompt: string, opts?: RunOptions) =>
      behavior(prompt, opts?.abortSignal, opts?.timeoutMs),
  };
}

const VALID_EVIDENCE = 'On line 42 of a.ts, the variable x is dereferenced without a null check, which would cause a runtime crash when the input is empty.';

function workerOutputWithEvidence(): string {
  return `I found an issue.\n\n${VALID_EVIDENCE}\n\nThat is all.`;
}

function validReviewerJson(): string {
  return JSON.stringify([{
    id: 'F1',
    severity: 'high',
    claim: 'null pointer deref',
    evidence: VALID_EVIDENCE,
    suggestion: 'Add null guard before deref',
    reviewerConfidence: 80,
  }]);
}

// ---------------------------------------------------------------------------
// Extraction pipeline: retry + fallback
// ---------------------------------------------------------------------------

describe('runQualityReview annotation path — extraction pipeline', () => {
  it('succeeds on first attempt when reviewer emits valid JSON with grounded evidence', async () => {
    const provider = makeProvider(async () => {
      return makeOkResult('```json\n' + validReviewerJson() + '\n```');
    });
    const result = await runQualityReview(
      provider,
      { prompt: 'audit this codebase for security issues', scope: [], doneCondition: 'complete' },
      fakeReport,
      {},
      [],
      [],
      undefined,
      buildAuditQualityPrompt,
      workerOutputWithEvidence(),
    );
    expect(result.status).toBe('annotated');
    expect(result.annotatedFindings).toHaveLength(1);
    expect(result.annotatedFindings![0].id).toBe('F1');
    expect(result.annotatedFindings![0].severity).toBe('high');
    expect(result.annotatedFindings![0].evidenceGrounded).toBe(true);
    expect(result.annotatedFindings![0].reviewerConfidence).toBe(80);
  });

  it('retries with reminder prompt when first response is unparseable, then succeeds', async () => {
    const runSpy = vi.fn();
    let calls = 0;
    const provider: Provider = {
      name: 'standard',
      config: { type: 'openai-compatible', model: 'mock', baseUrl: 'mock' } as any,
      run: async (prompt: string, opts?: RunOptions) => {
        runSpy(prompt, opts);
        calls += 1;
        if (calls === 1) {
          return makeOkResult('Everything looks fine, no issues here.');
        }
        expect(prompt).toMatch(/IMPORTANT.*previous response was not parseable/);
        return makeOkResult('```json\n' + validReviewerJson() + '\n```');
      },
    };
    const result = await runQualityReview(
      provider,
      { prompt: 'audit this codebase for security issues', scope: [], doneCondition: 'complete' },
      fakeReport,
      {},
      [],
      [],
      undefined,
      buildAuditQualityPrompt,
      workerOutputWithEvidence(),
    );
    expect(result.status).toBe('annotated');
    expect(result.annotatedFindings).toHaveLength(1);
    expect(result.annotatedFindings![0].id).toBe('F1');
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to deterministic extraction when both LLM attempts fail parse', async () => {
    const workerOutput = `## Findings

### 1. SQL Injection in login handler
Severity: high

The login handler concatenates user input directly into a SQL query
without parameterization, allowing attackers to bypass authentication.

### 2. Missing rate limiting on API
Severity: medium

The rate limiting middleware is commented out in the API gateway configuration.
`;
    const provider = makeProvider(async () => {
      return makeOkResult('Just some prose, no JSON block at all.');
    });
    const result = await runQualityReview(
      provider,
      { prompt: 'audit security', scope: [], doneCondition: 'complete' },
      fakeReport,
      {},
      [],
      [],
      undefined,
      buildAuditQualityPrompt,
      workerOutput,
    );
    // Verdict stays 'annotated' — never 'error' for parse failure
    expect(result.status).toBe('annotated');
    expect(result.annotatedFindings).toBeDefined();
    expect(result.annotatedFindings!.length).toBeGreaterThanOrEqual(1);
    // Fallback extracted findings have null reviewerConfidence
    for (const f of result.annotatedFindings!) {
      expect(f.reviewerConfidence).toBeNull();
    }
  });

  it('propagates transport failure on first attempt as error', async () => {
    const provider = makeProvider(async () => {
      return makeErrorResult('api_error');
    });
    const result = await runQualityReview(
      provider,
      { prompt: 'audit security', scope: [], doneCondition: 'complete' },
      fakeReport,
      {},
      [],
      [],
      undefined,
      buildAuditQualityPrompt,
      workerOutputWithEvidence(),
    );
    expect(result.status).toBe('api_error');
    expect(result.findings).toEqual([]);
    expect(result.errorReason).toBeDefined();
  });

  it('propagates transport failure on retry as error, NOT fallback', async () => {
    // Round-2 finding #1: transport failure on retry MUST propagate as error,
    // not silently fall back. Fallback is for parse failure of a real response,
    // never for infrastructure failure.
    let calls = 0;
    const provider = makeProvider(async () => {
      calls += 1;
      if (calls === 1) {
        return makeOkResult('No JSON here.');
      }
      return makeErrorResult('network_error');
    });
    const result = await runQualityReview(
      provider,
      { prompt: 'audit security', scope: [], doneCondition: 'complete' },
      fakeReport,
      {},
      [],
      [],
      undefined,
      buildAuditQualityPrompt,
      workerOutputWithEvidence(),
    );
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe('network_error');
    expect(result.findings).toEqual([]);
    expect(result.annotatedFindings).toBeUndefined();
    expect(result.errorReason).toBeDefined();
  });

  it('returns empty annotatedFindings when fallback extraction finds no issues', async () => {
    const workerOutput = 'No findings detected in this codebase. All checks passed.';
    const provider = makeProvider(async () => {
      return makeOkResult('unparseable prose response');
    });
    const result = await runQualityReview(
      provider,
      { prompt: 'audit', scope: [], doneCondition: 'done' },
      fakeReport,
      {},
      [],
      [],
      undefined,
      buildAuditQualityPrompt,
      workerOutput,
    );
    expect(result.status).toBe('annotated');
    expect(result.annotatedFindings).toEqual([]);
  });

  it('accumulates metrics across both attempts', async () => {
    let calls = 0;
    const provider = makeProvider(async () => {
      calls += 1;
      if (calls === 1) {
        return makeOkResult('no json');
      }
      return makeOkResult('```json\n' + validReviewerJson() + '\n```');
    });
    const result = await runQualityReview(
      provider,
      { prompt: 'audit security', scope: [], doneCondition: 'complete' },
      fakeReport,
      {},
      [],
      [],
      undefined,
      buildAuditQualityPrompt,
      workerOutputWithEvidence(),
    );
    expect(result.status).toBe('annotated');
    expect(calls).toBe(2);
    expect(result.metrics?.inputTokens).toBe(2);
    expect(result.metrics?.outputTokens).toBe(2);
    expect(result.metrics?.turnCount).toBe(2);
  });
});
