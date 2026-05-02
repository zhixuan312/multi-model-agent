import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryCalls: Array<{ options?: { env?: Record<string, string> } }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: vi.fn(async function* (opts: { options?: { env?: Record<string, string> } }) {
      queryCalls.push(opts);
      // Yield enough text to pass supervision's minimum-length heuristic
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'This is a complete sub-agent answer that is long enough to pass the validateCompletion minimum-length heuristic without any additional structural hints because it carries more than 200 characters of plain text content.',
            },
          ],
        },
        parent_tool_use_id: null,
      };
      yield {
        type: 'result',
        result:
          'This is a complete sub-agent answer that is long enough to pass the validateCompletion minimum-length heuristic without any additional structural hints because it carries more than 200 characters of plain text content.',
        usage: {},
        total_cost_usd: 0,
      };
    }),
  };
});

import { runClaude } from '../../packages/core/src/runners/claude-runner.js';

const defaults = { timeoutMs: 600_000, tools: 'full' as const };

describe('claude-runner env spread regression (Bug 3)', () => {
  beforeEach(() => {
    queryCalls.length = 0;
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('claude-compatible env block spreads process.env then applies overrides', async () => {
    // Set test env vars the spread should inherit
    const originalPath = process.env.PATH;
    const originalHome = process.env.HOME;
    process.env.PATH = '/usr/bin:/bin';
    process.env.HOME = '/Users/test';

    try {
      const cfg = {
        type: 'claude-compatible' as const,
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'sk-test',
      };

      await runClaude('prompt', {}, cfg, defaults);

      expect(queryCalls.length).toBe(1);
      const env = queryCalls[0].options?.env;
      expect(env).toBeDefined();
      expect(env!.PATH).toBe('/usr/bin:/bin');                                     // inherited via spread
      expect(env!.HOME).toBe('/Users/test');                                       // inherited via spread
      expect(env!.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');  // override on top
      expect(env!.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');                           // override on top
    } finally {
      // Restore original values to avoid side effects on other tests
      if (originalPath !== undefined) process.env.PATH = originalPath;
      else delete process.env.PATH;
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });
});
