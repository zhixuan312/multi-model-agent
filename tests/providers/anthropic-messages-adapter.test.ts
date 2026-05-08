import { describe, it, expect, vi } from 'vitest';
import { AnthropicMessagesAdapter } from '../../packages/core/src/providers/anthropic-messages-adapter.js';

const mkCreate = vi.fn();

// Adapter uses `messages.stream(...)` and awaits `stream.finalMessage()`.
// The mock returns a synthetic stream object whose finalMessage() resolves
// to the value mkCreate was configured with — keeps the existing per-test
// `mkCreate.mockResolvedValue(defaultResponse())` shape working.
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      stream: (args: unknown) => {
        const result = mkCreate(args);
        return {
          finalMessage: () => Promise.resolve(result),
        };
      },
    },
  })),
}));

function defaultResponse(overrides: Record<string, unknown> = {}) {
  return {
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
    },
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
    ...overrides,
  };
}

describe('AnthropicMessagesAdapter', () => {
  it('maps Anthropic usage to canonical 4-field shape', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new AnthropicMessagesAdapter({ apiKey: 'k', model: 'claude-sonnet-4-5', maxOutputTokens: 4096 });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: true, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 50, cachedReadTokens: 30, cachedNonReadTokens: 5 });
    expect(r.finishReason).toBe('stop');
  });

  it('infers finishReason tool_use when tool_use blocks present', async () => {
    mkCreate.mockResolvedValue(defaultResponse({
      content: [
        { type: 'text', text: 'using tool' },
        { type: 'tool_use', id: 'toolu_01', name: 'read', input: { path: '/x' } },
      ],
      stop_reason: 'tool_use',
    }));
    const a = new AnthropicMessagesAdapter({ apiKey: 'k', model: 'claude-sonnet-4-5', maxOutputTokens: 4096 });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.finishReason).toBe('tool_use');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ id: 'toolu_01', name: 'read', input: { path: '/x' } });
  });

  it('infers finishReason max_tokens on max_tokens stop_reason', async () => {
    mkCreate.mockResolvedValue(defaultResponse({
      content: [{ type: 'text', text: 'truncated' }],
      stop_reason: 'max_tokens',
    }));
    const a = new AnthropicMessagesAdapter({ apiKey: 'k', model: 'claude-sonnet-4-5', maxOutputTokens: 4096 });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.finishReason).toBe('max_tokens');
  });

  it('handles missing cache fields gracefully (claude-compatible)', async () => {
    mkCreate.mockResolvedValue(defaultResponse({
      usage: { input_tokens: 100, output_tokens: 50 },
    }));
    const a = new AnthropicMessagesAdapter({
      apiKey: 'k', model: 'claude-sonnet-4-5', maxOutputTokens: 4096, providerType: 'claude-compatible',
    });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 });
  });

  it('providerType defaults to claude', () => {
    const a = new AnthropicMessagesAdapter({ apiKey: 'k', model: 'm', maxOutputTokens: 4096 });
    expect(a.providerType).toBe('claude');
  });

  it('providerType can be set to claude-compatible', () => {
    const a = new AnthropicMessagesAdapter({ apiKey: 'k', model: 'm', maxOutputTokens: 4096, providerType: 'claude-compatible' });
    expect(a.providerType).toBe('claude-compatible');
  });

  it('builds messages with tool_use and tool_result for prior turns', async () => {
    mkCreate.mockResolvedValue(defaultResponse({ content: [{ type: 'text', text: 'ok' }] }));
    const a = new AnthropicMessagesAdapter({ apiKey: 'k', model: 'claude-sonnet-4-5', maxOutputTokens: 4096 });

    await a.turn({
      systemPrompt: 'You are helpful.',
      userMessage: 'read /etc/hosts',
      priorTurns: [
        {
          assistantText: 'I will read the file.',
          toolCalls: [
            { name: 'read', input: { path: '/etc/hosts' }, result: '127.0.0.1 localhost' },
          ],
        },
      ],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });

    const callArgs = mkCreate.mock.lastCall[0];
    expect(callArgs.system).toBe('You are helpful.');
    const msgs = callArgs.messages;
    expect(msgs).toHaveLength(3); // assistant (with tool_use), user (tool_result), user (current message)

    // Assistant message should have text + tool_use blocks
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toHaveLength(2);
    expect(msgs[0].content[0]).toMatchObject({ type: 'text', text: 'I will read the file.' });
    expect(msgs[0].content[1]).toMatchObject({ type: 'tool_use', name: 'read', input: { path: '/etc/hosts' } });
    expect(msgs[0].content[1].id).toMatch(/^toolu_/);

    // User message should be tool_result
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toHaveLength(1);
    expect(msgs[1].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: msgs[0].content[1].id,
      content: '127.0.0.1 localhost',
    });

    // Final user message
    expect(msgs[2]).toEqual({ role: 'user', content: 'read /etc/hosts' });
  });

  it('stringifies non-string tool results', async () => {
    mkCreate.mockResolvedValue(defaultResponse({ content: [{ type: 'text', text: 'ok' }] }));
    const a = new AnthropicMessagesAdapter({ apiKey: 'k', model: 'claude-sonnet-4-5', maxOutputTokens: 4096 });

    await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [
        {
          assistantText: '',
          toolCalls: [
            { name: 'search', input: { q: 'x' }, result: { items: [1, 2, 3] } },
          ],
        },
      ],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });

    const msgs = mkCreate.mock.lastCall[0].messages;
    expect(msgs[1].content[0].content).toBe('{"items":[1,2,3]}');
  });

  it('maps tool definitions to Anthropic input_schema format', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new AnthropicMessagesAdapter({ apiKey: 'k', model: 'claude-sonnet-4-5', maxOutputTokens: 4096 });

    await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [
        { name: 'read', description: 'Read a file', schema: { type: 'object', properties: { path: { type: 'string' } } } },
      ],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });

    const callArgs = mkCreate.mock.lastCall[0];
    expect(callArgs.tools).toEqual([
      { name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
    ]);
  });
});
