import { describe, it, expect } from 'vitest';
import type { RunnerAdapter } from '../helpers/test-harness.js';

const VALID_PROVIDER_TYPES = ['claude', 'claude', 'openai', 'codex', 'codex'] as const;

function assertConformance(adapter: RunnerAdapter): void {
  expect(VALID_PROVIDER_TYPES).toContain(adapter.providerType);
}

describe('RunnerAdapter contract', () => {
  it('mockAdapter declares providerType', async () => {
    const { mockAdapter } = await import('../contract/fixtures/mock-providers.js');
    const a = mockAdapter({ turns: [{ assistantText: 'x', toolCalls: [] }] });
    expect(a.providerType).toBe('claude');
    assertConformance(a);
  });

  it('mockAdapter turn returns finishReason', async () => {
    const { mockAdapter } = await import('../contract/fixtures/mock-providers.js');
    const a = mockAdapter({ turns: [{ assistantText: 'x', toolCalls: [] }] });
    const result = await a.turn({
      systemPrompt: '',
      userMessage: '',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: {
        cache_control: false,
        thinking: false,
        vision: false,
        tool_use: false,
        streaming: false,
        other: [],
      },
    });
    expect(['stop', 'tool_use', 'max_tokens', 'error']).toContain(result.finishReason);
    expect(result).toHaveProperty('assistantText');
    expect(result).toHaveProperty('toolCalls');
    expect(result).toHaveProperty('usage');
  });

  it('mockAdapter infers finishReason from tool calls', async () => {
    const { mockAdapter } = await import('../contract/fixtures/mock-providers.js');
    const a = mockAdapter({
      turns: [{ assistantText: 'done', toolCalls: [{ name: 'read', input: {} }] }],
    });
    const result = await a.turn({
      systemPrompt: '',
      userMessage: '',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: {
        cache_control: false,
        thinking: false,
        vision: false,
        tool_use: false,
        streaming: false,
        other: [],
      },
    });
    expect(result.finishReason).toBe('tool_use');
  });
});
