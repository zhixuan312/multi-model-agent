import { vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Task 19: OpenAI typed reviewer findings round-trip (Bug 4 G2/G3)
//
// When runMode='review', the runner sets Agent.outputType = reviewerOutputType
// (a Zod schema). The @openai/agents SDK then returns the parsed structured
// output as finalOutput — a PLAIN object { findings: [...] }, not a string.
// This test verifies:
//   1. The runner safely handles non-string finalOutput in review mode by
//      extracting validation text from newItems instead of calling string
//      methods on the structured object.
//   2. All four severity levels round-trip correctly into parsedFindings.
//   3. evidenceGrounded is annotated on each finding.
//   4. The legacy parseReviewerFindings (JSON-block path) is never invoked.
// ---------------------------------------------------------------------------

// Spy on parseReviewerFindings BEFORE the runner module is loaded, so we can
// assert it was never called during the typed-output path.
const parseReviewerFindingsSpy = vi.fn();

vi.mock('../../packages/core/src/review/parse-reviewer-findings.js', () => ({
  parseReviewerFindings: parseReviewerFindingsSpy,
}));

// Partial mock of @openai/agents — same pattern as openai-runner.test.ts
vi.mock('@openai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openai/agents')>();
  return {
    ...actual,
    Agent: vi.fn().mockImplementation((opts: Record<string, unknown>) => ({
      __mockAgent: true,
      name: opts.name,
      instructions: opts.instructions,
      tools: opts.tools,
      modelSettings: opts.modelSettings,
      outputType: opts.outputType,
    })),
    run: vi.fn(),
    setTracingDisabled: vi.fn(),
    OpenAIChatCompletionsModel: vi.fn().mockImplementation(() => ({ __mockModel: true })),
  };
});

const { Agent: MockAgent, run: mockRun } = vi.mocked(
  await import('@openai/agents'),
);

// ---------------------------------------------------------------------------
// Test payloads
// ---------------------------------------------------------------------------

/**
 * A well-formed reviewer output matching the `reviewerOutputType` Zod schema.
 * Each finding has severity, claim, evidence (>= 20 chars), id, and
 * reviewerConfidence. The evidence strings are chosen to be verbatim
 * substrings of the worker output below so `evidenceGrounded` is true.
 */
const findingsPayload = {
  findings: [
    {
      id: 'F1',
      severity: 'critical' as const,
      claim: 'SQL injection in login endpoint allows authentication bypass',
      evidence: 'the query string is concatenated directly into the SQL without parameterization',
      suggestion: 'Use parameterized queries immediately',
      reviewerConfidence: 95,
    },
    {
      id: 'F2',
      severity: 'high' as const,
      claim: 'Missing rate limiting on password reset endpoint',
      evidence: 'the password reset handler has no rate limit middleware applied',
      suggestion: 'Add rate limiting with a 5/minute window',
      reviewerConfidence: 90,
    },
    {
      id: 'F3',
      severity: 'medium' as const,
      claim: 'Error messages expose internal stack traces to clients',
      evidence: 'the catch block returns err.stack directly in the 500 response body',
      suggestion: 'Replace with a generic error message in production',
      reviewerConfidence: 85,
    },
    {
      id: 'F4',
      severity: 'low' as const,
      claim: 'Console.log statements left in production authentication module',
      evidence: 'there are leftover console.log calls in the auth middleware file',
      suggestion: 'Remove or replace with structured logging',
      reviewerConfidence: 80,
    },
  ],
};

/**
 * Simulated worker output text. This is the implementer's narrative that the
 * reviewer findings reference via the `evidence` field. It must be >= 200
 * chars so validateCompletion passes the minimum-length heuristic.
 *
 * Every evidence string from the payload above appears verbatim in this text.
 */
const WORKER_OUTPUT = `
Security audit of the authentication module revealed several issues.

First, the query string is concatenated directly into the SQL without parameterization
in the login handler at src/auth/login.ts line 42. This is a textbook SQL injection
vulnerability that allows authentication bypass by crafting a malicious username.

Second, the password reset handler has no rate limit middleware applied, which means
an attacker can brute-force reset tokens at the /api/auth/reset endpoint without any
throttling or lockout mechanism.

Third, the catch block returns err.stack directly in the 500 response body, exposing
internal file paths, function names, and stack frames to any client that triggers an
unhandled error. This is an information disclosure issue that aids reconnaissance.

Finally, there are leftover console.log calls in the auth middleware file at
src/middleware/auth.ts that log session tokens in development mode. These were
likely debugging leftovers but they remain in the production build.

The codebase overall follows reasonable patterns but these issues should be addressed
before the next release. The SQL injection finding is critical and should be fixed
immediately as it is remotely exploitable without authentication.
`.trim();

/**
 * Build a mock @openai/agents RunResult for review mode.
 *
 * finalOutput is a PLAIN structured object { findings: [...] } — exactly what
 * the SDK returns when Agent.outputType is set. It has NO string methods
 * (.replace, .trimStart, etc). The runner MUST extract validation text from
 * newItems instead of calling string methods on finalOutput.
 *
 * newItems contains the worker's narrative output (the implementer's text
 * that findings reference via evidence). validateSubAgentOutput and
 * evidenceIsGrounded both consume this text.
 */
function makeMockReviewResult() {
  return {
    finalOutput: { findings: findingsPayload.findings },
    newItems: [
      {
        type: 'message_output_item' as const,
        rawItem: {
          role: 'assistant' as const,
          content: [{ type: 'output_text' as const, text: WORKER_OUTPUT }],
        },
      },
    ],
    history: [],
    state: {
      usage: {
        inputTokens: 3000,
        outputTokens: 800,
        totalTokens: 3800,
        requests: 1,
        inputTokensDetails: [],
        outputTokensDetails: [],
      },
    },
  };
}

/**
 * Build a mock result for non-review (standard) mode. In this mode the SDK
 * returns a string finalOutput, not a structured object.
 */
function makeMockStandardResult() {
  const text = 'This is a complete sub-agent answer that is long enough to pass the validateCompletion minimum-length heuristic without any additional structural hints because it carries more than 200 characters of plain text content.';
  return {
    finalOutput: text,
    newItems: [
      {
        type: 'message_output_item' as const,
        rawItem: {
          role: 'assistant' as const,
          content: [{ type: 'output_text' as const, text }],
        },
      },
    ],
    history: [],
    state: {
      usage: {
        inputTokens: 500,
        outputTokens: 100,
        totalTokens: 600,
        requests: 1,
        inputTokensDetails: [],
        outputTokensDetails: [],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const providerConfig = {
  type: 'openai-compatible' as const,
  model: 'test-model',
  baseUrl: 'http://localhost:9999',
  apiKey: 'test-key',
};
const defaults = { timeoutMs: 600_000, tools: 'full' as const };
const clientStub = {} as unknown as import('openai').default;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runOpenAI — typed reviewer findings round-trip (runMode: review)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockReset();
    parseReviewerFindingsSpy.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('parses four-severity findings via Agent.outputType when finalOutput is a plain object', async () => {
    mockRun.mockResolvedValueOnce(makeMockReviewResult());

    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');

    const result = await runOpenAI(
      'Review the authentication module for security issues',
      { runMode: 'review' },
      { client: clientStub, providerConfig, defaults },
    );

    // The run should succeed
    expect(result.status).toBe('ok');

    // parsedFindings must be populated with all four findings
    expect(result.parsedFindings).not.toBeNull();
    const findings = result.parsedFindings!;
    expect(findings).toHaveLength(4);

    // All four severities preserved verbatim
    const severities = findings.map((f) => f.severity);
    expect(severities).toEqual(['critical', 'high', 'medium', 'low']);

    // IDs preserved
    expect(findings.map((f) => f.id)).toEqual(['F1', 'F2', 'F3', 'F4']);

    // All findings have evidenceGrounded annotated
    for (const f of findings) {
      expect(f).toHaveProperty('evidenceGrounded');
      expect(typeof f.evidenceGrounded).toBe('boolean');
    }

    // The evidence should all be grounded (present in worker output after
    // whitespace normalization)
    for (const f of findings) {
      expect(f.evidenceGrounded).toBe(true);
    }

    // Claims and suggestions preserved
    expect(findings[0].claim).toContain('SQL injection');
    expect(findings[0].suggestion).toContain('parameterized queries');
    expect(findings[1].suggestion).toContain('rate limiting');

    // Confidence scores preserved
    expect(findings[0].reviewerConfidence).toBe(95);
    expect(findings[3].reviewerConfidence).toBe(80);

    // The output field should be the worker's narrative text (extracted from
    // newItems), not the structured object stringified
    expect(result.output).toBe(WORKER_OUTPUT);

    // The legacy JSON-block path was NEVER called
    expect(parseReviewerFindingsSpy).not.toHaveBeenCalled();

    // The Agent was constructed with outputType set to a non-text output type
    // (the reviewerOutputType Zod schema). Verify it's an object (Zod schema),
    // not the string 'text'.
    const agentCall = MockAgent.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(agentCall).toBeDefined();
    const outputType = agentCall!.outputType;
    expect(outputType).toBeDefined();
    expect(outputType).not.toBe('text');
    expect(typeof outputType).toBe('object');
  });

  it('sets parsedFindings to null when runMode is NOT review', async () => {
    mockRun.mockResolvedValueOnce(makeMockStandardResult());

    const { runOpenAI } = await import('../../packages/core/src/runners/openai-runner.js');

    const result = await runOpenAI(
      'Do something',
      { runMode: 'standard' },
      { client: clientStub, providerConfig, defaults },
    );

    expect(result.status).toBe('ok');
    expect(result.parsedFindings).toBeNull();
    expect(parseReviewerFindingsSpy).not.toHaveBeenCalled();
  });
});
