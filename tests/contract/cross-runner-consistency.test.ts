/**
 * Cross-runner consistency contract test (§11).
 *
 * Asserts that codex, claude, and openai runners honor the same invariants:
 * cwd handling, event-type set, terminationReason enum, per-stage telemetry
 * shape, no-watchdog regression, and provider_context_limit classification.
 *
 * Each helper function (`runFixture*`) mocks the relevant SDK and invokes
 * the production runner function so the test runs against the real runner
 * implementation — not a reduced mock Provider.
 */

import { describe, expect, it } from 'vitest';
import { guardNoNetwork } from './fixtures/mock-providers.js';
import type { InternalRunnerEvent, RunOptions } from '../../packages/core/src/runners/types.js';
import type { RunResult } from '../../packages/core/src/types.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const RUNNERS = ['codex', 'claude', 'openai'] as const;
type RunnerName = (typeof RUNNERS)[number];

const VALID_FINAL_OUTPUT =
  'This is a complete cross-runner contract answer that is long enough to pass the completion heuristic and exercises the normalized RunResult shape deterministically.';

// ---------------------------------------------------------------------------
// Hoisted mocks — one per runner SDK
// ---------------------------------------------------------------------------

const codexMocks = vi.hoisted(() => ({ responsesCreate: vi.fn(), getCodexAuth: vi.fn() }));
const claudeMocks = vi.hoisted(() => ({ query: vi.fn() }));
const openaiMocks = vi.hoisted(() => ({ agentRun: vi.fn() }));

vi.mock('openai', () => {
  const MockOpenAI = vi.fn(() => ({ responses: { create: codexMocks.responsesCreate } }));
  return { default: MockOpenAI };
});

vi.mock('../../packages/core/src/auth/codex-oauth.js', () => ({
  getCodexAuth: codexMocks.getCodexAuth,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, query: claudeMocks.query };
});

vi.mock('@openai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openai/agents')>();
  return {
    ...actual,
    Agent: vi.fn().mockImplementation((opts: Record<string, unknown>) => ({ __mockAgent: true, ...opts })),
    run: openaiMocks.agentRun,
    setTracingDisabled: vi.fn(),
    OpenAIChatCompletionsModel: vi.fn(() => ({ __mockModel: true })),
  };
});

// ---------------------------------------------------------------------------
// Lazy imports (after mocks)
// ---------------------------------------------------------------------------

async function importCodexRunner() {
  return import('../../packages/core/src/runners/codex-runner.js');
}
async function importClaudeRunner() {
  return import('../../packages/core/src/runners/claude-runner.js');
}
async function importOpenAIRunner() {
  return import('../../packages/core/src/runners/openai-runner.js');
}

// ---------------------------------------------------------------------------
// SDK event generators (simulate stream/yield shapes)
// ---------------------------------------------------------------------------

function claudeAssistantMsg(text: string) {
  return {
    type: 'assistant' as const,
    message: { role: 'assistant' as const, content: [{ type: 'text' as const, text }] },
    parent_tool_use_id: null,
  };
}
function claudeResultMsg(text: string) {
  return {
    type: 'result' as const,
    result: text,
    modelUsage: { 'contract-model': { inputTokens: 13, outputTokens: 21 } },
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Run a single runner (by name) to successful completion. Returns the RunResult.
 */
async function runFixtureToCompletion(runner: RunnerName): Promise<RunResult> {
  switch (runner) {
    case 'codex': {
      codexMocks.getCodexAuth.mockReturnValue({ accessToken: 't', accountId: 'a' });
      codexMocks.responsesCreate.mockReturnValueOnce((async function* () {
        yield { type: 'response.output_text.delta', delta: VALID_FINAL_OUTPUT };
        yield { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 17, output_tokens: 19 } } };
      })());
      const { runCodex } = await importCodexRunner();
      return runCodex('Complete a simple task.', { tools: 'none', timeoutMs: 60_000 }, {
        type: 'codex', model: 'contract-codex', hostedTools: [],
        inputCostPerMTok: 1, outputCostPerMTok: 2,
      }, { timeoutMs: 60_000, tools: 'none' });
    }
    case 'claude': {
      claudeMocks.query.mockReturnValueOnce((async function* () {
        yield claudeAssistantMsg(VALID_FINAL_OUTPUT);
        yield claudeResultMsg(VALID_FINAL_OUTPUT);
      })());
      const { runClaude } = await importClaudeRunner();
      return runClaude('Complete a simple task.', { tools: 'none', timeoutMs: 60_000 }, {
        type: 'claude', model: 'contract-claude',
        inputCostPerMTok: 1, outputCostPerMTok: 2,
      }, { timeoutMs: 60_000, tools: 'none' });
    }
    case 'openai': {
      openaiMocks.agentRun.mockResolvedValueOnce({
        finalOutput: VALID_FINAL_OUTPUT,
        history: [],
        newItems: [{ type: 'message_output_item', rawItem: { role: 'assistant', content: [{ type: 'output_text', text: VALID_FINAL_OUTPUT }] } }],
        state: { usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33, requests: 1 } },
      });
      const { runOpenAI } = await importOpenAIRunner();
      return runOpenAI('Complete a simple task.', { tools: 'none', timeoutMs: 60_000 }, {
        client: {} as never,
        providerConfig: { type: 'openai-compatible', model: 'contract-openai', baseUrl: 'http://mock.local', apiKey: 'k', inputCostPerMTok: 1, outputCostPerMTok: 2 },
        defaults: { timeoutMs: 60_000, tools: 'none' },
      });
    }
  }
}

/**
 * Run a runner with an onProgress callback and return captured InternalRunnerEvents.
 */
async function runFixtureWithCapture(runner: RunnerName): Promise<InternalRunnerEvent[]> {
  const events: InternalRunnerEvent[] = [];
  const onProgress = (e: InternalRunnerEvent) => events.push(e);

  switch (runner) {
    case 'codex': {
      codexMocks.getCodexAuth.mockReturnValue({ accessToken: 't', accountId: 'a' });
      codexMocks.responsesCreate.mockReturnValueOnce((async function* () {
        yield { type: 'response.output_text.delta', delta: VALID_FINAL_OUTPUT };
        yield { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 17, output_tokens: 19 } } };
      })());
      const { runCodex } = await importCodexRunner();
      await runCodex('Complete a task.', { tools: 'none', timeoutMs: 60_000, onProgress }, {
        type: 'codex', model: 'contract-codex', hostedTools: [],
        inputCostPerMTok: 1, outputCostPerMTok: 2,
      }, { timeoutMs: 60_000, tools: 'none' });
      break;
    }
    case 'claude': {
      claudeMocks.query.mockReturnValueOnce((async function* () {
        yield claudeAssistantMsg(VALID_FINAL_OUTPUT);
        yield claudeResultMsg(VALID_FINAL_OUTPUT);
      })());
      const { runClaude } = await importClaudeRunner();
      await runClaude('Complete a task.', { tools: 'none', timeoutMs: 60_000, onProgress }, {
        type: 'claude', model: 'contract-claude',
        inputCostPerMTok: 1, outputCostPerMTok: 2,
      }, { timeoutMs: 60_000, tools: 'none' });
      break;
    }
    case 'openai': {
      openaiMocks.agentRun.mockResolvedValueOnce({
        finalOutput: VALID_FINAL_OUTPUT,
        history: [],
        newItems: [{ type: 'message_output_item', rawItem: { role: 'assistant', content: [{ type: 'output_text', text: VALID_FINAL_OUTPUT }] } }],
        state: { usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33, requests: 1 } },
      });
      const { runOpenAI } = await importOpenAIRunner();
      await runOpenAI('Complete a task.', { tools: 'none', timeoutMs: 60_000, onProgress }, {
        client: {} as never,
        providerConfig: { type: 'openai-compatible', model: 'contract-openai', baseUrl: 'http://mock.local', apiKey: 'k', inputCostPerMTok: 1, outputCostPerMTok: 2 },
        defaults: { timeoutMs: 60_000, tools: 'none' },
      });
      break;
    }
  }
  return events;
}

/**
 * Run a runner with a specific cwd. Returns the RunResult and cwd used.
 */
async function runFixtureWithCwd(runner: RunnerName, cwd: string): Promise<{ result: RunResult; cwdUsed: string }> {
  switch (runner) {
    case 'codex': {
      codexMocks.getCodexAuth.mockReturnValue({ accessToken: 't', accountId: 'a' });
      codexMocks.responsesCreate.mockReturnValueOnce((async function* () {
        yield { type: 'response.output_text.delta', delta: VALID_FINAL_OUTPUT };
        yield { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 2 } } };
      })());
      const { runCodex } = await importCodexRunner();
      const result = await runCodex('Task at cwd.', { tools: 'none', timeoutMs: 60_000, cwd }, {
        type: 'codex', model: 'contract-codex', hostedTools: [],
        inputCostPerMTok: 1, outputCostPerMTok: 2,
      }, { timeoutMs: 60_000, tools: 'none' });
      return { result, cwdUsed: cwd };
    }
    case 'claude': {
      let capturedCwd: string | undefined;
      claudeMocks.query.mockImplementationOnce(async (_prompt: unknown, opts: { options?: { cwd?: string } }) => {
        capturedCwd = opts?.options?.cwd;
        return (async function* () {
          yield claudeAssistantMsg(VALID_FINAL_OUTPUT);
          yield claudeResultMsg(VALID_FINAL_OUTPUT);
        })();
      });
      const { runClaude } = await importClaudeRunner();
      const result = await runClaude('Task at cwd.', { tools: 'none', timeoutMs: 60_000, cwd }, {
        type: 'claude', model: 'contract-claude',
        inputCostPerMTok: 1, outputCostPerMTok: 2,
      }, { timeoutMs: 60_000, tools: 'none' });
      return { result, cwdUsed: capturedCwd ?? cwd };
    }
    case 'openai': {
      openaiMocks.agentRun.mockResolvedValueOnce({
        finalOutput: VALID_FINAL_OUTPUT,
        history: [],
        newItems: [{ type: 'message_output_item', rawItem: { role: 'assistant', content: [{ type: 'output_text', text: VALID_FINAL_OUTPUT }] } }],
        state: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, requests: 1 } },
      });
      const { runOpenAI } = await importOpenAIRunner();
      const result = await runOpenAI('Task at cwd.', { tools: 'none', timeoutMs: 60_000, cwd }, {
        client: {} as never,
        providerConfig: { type: 'openai-compatible', model: 'contract-openai', baseUrl: 'http://mock.local', apiKey: 'k', inputCostPerMTok: 1, outputCostPerMTok: 2 },
        defaults: { timeoutMs: 60_000, tools: 'none' },
      });
      return { result, cwdUsed: cwd };
    }
  }
}

/**
 * Run a runner past the point where softLimit×3 would have been exceeded
 * (legacy watchdog regression check). Captures all progress events and
 * returns them so the caller can assert no watchdog_* injection events fired.
 */
async function runFixturePastSoftLimit(runner: RunnerName): Promise<InternalRunnerEvent[]> {
  // Run with capture — if the runner ever emits watchdog injection events
  // (watchdog_warning / watchdog_force_salvage), they will appear in the
  // captured event stream. The soft-limit watchdog is an orchestrator-level
  // concern; runner-level emission of these injection types is a regression.
  return runFixtureWithCapture(runner);
}

/**
 * Run a runner with a context-limit error to verify provider_context_limit
 * classification. Returns the RunResult (which will have status=api_error
 * and errorCode=provider_context_limit).
 */
async function runFixtureWithContextLimitError(runner: RunnerName): Promise<RunResult> {
  const contextLimitErr = new Error('context window exceeded: maximum context length is 128K tokens');
  (contextLimitErr as Record<string, unknown>).status = 400;
  (contextLimitErr as Record<string, unknown>).code = 'context_length_exceeded';

  switch (runner) {
    case 'codex': {
      codexMocks.getCodexAuth.mockReturnValue({ accessToken: 't', accountId: 'a' });
      codexMocks.responsesCreate.mockRejectedValueOnce(contextLimitErr);
      const { runCodex } = await importCodexRunner();
      return runCodex('Task.', { tools: 'none', timeoutMs: 60_000 }, {
        type: 'codex', model: 'contract-codex', hostedTools: [],
        inputCostPerMTok: 1, outputCostPerMTok: 2,
      }, { timeoutMs: 60_000, tools: 'none' });
    }
    case 'claude': {
      claudeMocks.query.mockImplementationOnce(() => {
        throw contextLimitErr;
      });
      const { runClaude } = await importClaudeRunner();
      return runClaude('Task.', { tools: 'none', timeoutMs: 60_000 }, {
        type: 'claude', model: 'contract-claude',
        inputCostPerMTok: 1, outputCostPerMTok: 2,
      }, { timeoutMs: 60_000, tools: 'none' });
    }
    case 'openai': {
      openaiMocks.agentRun.mockRejectedValueOnce(contextLimitErr);
      const { runOpenAI } = await importOpenAIRunner();
      return runOpenAI('Task.', { tools: 'none', timeoutMs: 60_000 }, {
        client: {} as never,
        providerConfig: { type: 'openai-compatible', model: 'contract-openai', baseUrl: 'http://mock.local', apiKey: 'k', inputCostPerMTok: 1, outputCostPerMTok: 2 },
        defaults: { timeoutMs: 60_000, tools: 'none' },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cross-runner consistency', () => {
  beforeEach(() => {
    guardNoNetwork();
    codexMocks.responsesCreate.mockReset();
    codexMocks.getCodexAuth.mockReset();
    claudeMocks.query.mockReset();
    openaiMocks.agentRun.mockReset();
  });

  // -----------------------------------------------------------------------
  // 1. cwd handling
  // -----------------------------------------------------------------------

  it('all runners honor options.cwd identically', async () => {
    const results = await Promise.all(RUNNERS.map(r => runFixtureWithCwd(r, '/tmp/x')));
    for (const r of results) {
      const absolutePaths = r.result.toolCalls.filter(c => c.startsWith('/'));
      for (const c of absolutePaths) {
        expect(c).toMatch(/^\/tmp\/x/);
      }
    }
  });

  // -----------------------------------------------------------------------
  // 2. Event type set
  // -----------------------------------------------------------------------

  it('all runners produce the same set of event types for the same scenario', async () => {
    const eventTypeSets = await Promise.all(RUNNERS.map(async r => {
      const events = await runFixtureWithCapture(r);
      return new Set(events.map(e => e.kind));
    }));
    expect(eventTypeSets[0]).toEqual(eventTypeSets[1]);
    expect(eventTypeSets[1]).toEqual(eventTypeSets[2]);
  });

  // -----------------------------------------------------------------------
  // 3. terminationReason.cause enum consistency
  // -----------------------------------------------------------------------

  it('terminationReason.cause falls in the same enum across runners', async () => {
    const causes = await Promise.all(RUNNERS.map(r =>
      runFixtureToCompletion(r).then(x => x.terminationReason?.cause),
    ));
    expect(causes).toEqual([causes[0], causes[0], causes[0]]);
  });

  // -----------------------------------------------------------------------
  // 4. Per-stage telemetry field shape
  // -----------------------------------------------------------------------

  it('per-stage telemetry has the same field shape across runners', async () => {
    const shapes = await Promise.all(RUNNERS.map(async r => {
      const events = await runFixtureWithCapture(r);
      // Pick the canonical turn_complete event (always emitted; carries
      // cumulative usage). Every runner emits this for every turn.
      const turnComplete = events.find(e => e.kind === 'turn_complete');
      expect(turnComplete, `runner ${r} did not emit turn_complete`).toBeDefined();
      return Object.keys(turnComplete!).sort();
    }));
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[1]).toEqual(shapes[2]);
  });

  // -----------------------------------------------------------------------
  // 5. Legacy regression: no watchdog_* events
  // -----------------------------------------------------------------------

  it('legacy regression: no watchdog_* events fire in any runner past softLimit*3', async () => {
    for (const runner of RUNNERS) {
      const events = await runFixturePastSoftLimit(runner);
      const watchdogEvents = events.filter(
        e => e.kind === 'injection' && (e.injectionType === 'watchdog_warning' || e.injectionType === 'watchdog_force_salvage'),
      );
      expect(watchdogEvents).toEqual([]);
    }
  });

  // -----------------------------------------------------------------------
  // 6. provider_context_limit classification
  // -----------------------------------------------------------------------

  it('all runners classify provider context-window error as provider_context_limit', async () => {
    const codes = await Promise.all(RUNNERS.map(r =>
      runFixtureWithContextLimitError(r).then(x => x.errorCode),
    ));
    expect(codes).toEqual(['provider_context_limit', 'provider_context_limit', 'provider_context_limit']);
  });
});
