import { describe, it, expect, vi } from 'vitest';
import { OpenAIChatAdapter } from '../../packages/core/src/providers/openai-chat-adapter.js';

const mkCreate = vi.fn();

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mkCreate } },
  })),
}));

function defaultResponse(overrides: Record<string, unknown> = {}) {
  return {
    usage: {
      prompt_tokens: 150,
      completion_tokens: 80,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 10 },
    },
    choices: [{
      finish_reason: 'stop',
      message: { content: 'Hello from OpenAI', tool_calls: null },
    }],
    ...overrides,
  };
}

describe('OpenAIChatAdapter', () => {
  it('maps OpenAI usage to canonical 4-field shape with reasoning folded into outputTokens', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIChatAdapter({ apiKey: 'k', model: 'gpt-5' });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.usage).toEqual({
      inputTokens: 150,
      outputTokens: 90, // completion_tokens (80) + reasoning_tokens (10)
      cachedReadTokens: 20,
      cachedNonReadTokens: 0,
    });
    expect(r.finishReason).toBe('stop');
  });

  it('infers finishReason tool_use when tool_calls present in response', async () => {
    mkCreate.mockResolvedValue(defaultResponse({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: 'Using tool',
          tool_calls: [{
            id: 'call_abc123',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"/x"}' },
          }],
        },
      }],
    }));
    const a = new OpenAIChatAdapter({ apiKey: 'k', model: 'gpt-5' });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.finishReason).toBe('tool_use');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ id: 'call_abc123', name: 'read', input: { path: '/x' } });
  });

  it('infers finishReason max_tokens on length or other finish_reason', async () => {
    mkCreate.mockResolvedValue(defaultResponse({
      choices: [{ finish_reason: 'length', message: { content: 'truncated', tool_calls: null } }],
    }));
    const a = new OpenAIChatAdapter({ apiKey: 'k', model: 'gpt-5' });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.finishReason).toBe('max_tokens');
  });

  it('handles missing usage fields gracefully (openai-compatible)', async () => {
    mkCreate.mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { content: 'ok', tool_calls: null } }],
    });
    const a = new OpenAIChatAdapter({
      apiKey: 'k', model: 'custom-model', providerType: 'openai-compatible',
    });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedNonReadTokens: 0,
    });
  });

  it('providerType defaults to openai', () => {
    const a = new OpenAIChatAdapter({ apiKey: 'k', model: 'm' });
    expect(a.providerType).toBe('openai');
  });

  it('providerType can be set to openai-compatible', () => {
    const a = new OpenAIChatAdapter({ apiKey: 'k', model: 'm', providerType: 'openai-compatible' });
    expect(a.providerType).toBe('openai-compatible');
  });

  it('builds messages with tool_calls and tool results for prior turns', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIChatAdapter({ apiKey: 'k', model: 'gpt-5' });

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
    const msgs = callArgs.messages;
    expect(msgs).toHaveLength(4); // system, assistant, tool, user

    expect(msgs[0]).toEqual({ role: 'system', content: 'You are helpful.' });

    // Assistant message with tool_calls
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toBe('I will read the file.');
    expect(msgs[1].tool_calls).toHaveLength(1);
    expect(msgs[1].tool_calls[0]).toMatchObject({
      id: 'call_0_0',
      type: 'function',
      function: { name: 'read', arguments: '{"path":"/etc/hosts"}' },
    });

    // Tool result message
    expect(msgs[2].role).toBe('tool');
    expect(msgs[2].tool_call_id).toBe('call_0_0');
    expect(msgs[2].content).toBe('127.0.0.1 localhost');

    // Final user message
    expect(msgs[3]).toEqual({ role: 'user', content: 'read /etc/hosts' });
  });

  it('stringifies non-string tool results', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIChatAdapter({ apiKey: 'k', model: 'gpt-5' });

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
    expect(msgs[2].content).toBe('{"items":[1,2,3]}');
  });

  it('maps tool definitions to OpenAI function format', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIChatAdapter({ apiKey: 'k', model: 'gpt-5' });

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
      { type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    ]);
  });

  it('wraps malformed JSON tool arguments instead of crashing', async () => {
    mkCreate.mockResolvedValue({
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{
            id: 'call_bad',
            type: 'function',
            function: { name: 'run', arguments: '{not valid json' },
          }],
        },
      }],
    });
    const a = new OpenAIChatAdapter({ apiKey: 'k', model: 'gpt-5' });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.toolCalls[0].input).toMatchObject({
      __mma_invalid_arguments: '{not valid json',
      __mma_parse_error: expect.any(String),
    });
    expect(r.finishReason).toBe('tool_use');
  });

  it('returns error finishReason for empty choices', async () => {
    mkCreate.mockResolvedValue({
      usage: { prompt_tokens: 5, completion_tokens: 0 },
      choices: [],
    });
    const a = new OpenAIChatAdapter({ apiKey: 'k', model: 'gpt-5' });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.finishReason).toBe('error');
    expect(r.errorCode).toBe('empty_choices');
    expect(r.assistantText).toBe('');
    expect(r.toolCalls).toEqual([]);
  });

  it('uses deterministic tool_call_ids across prior turns', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIChatAdapter({ apiKey: 'k', model: 'gpt-5' });

    await a.turn({
      systemPrompt: '',
      userMessage: 'third turn',
      priorTurns: [
        {
          assistantText: 'turn 0',
          toolCalls: [
            { name: 'read', input: { path: '/a' }, result: 'content A' },
            { name: 'read', input: { path: '/b' }, result: 'content B' },
          ],
        },
        {
          assistantText: 'turn 1',
          toolCalls: [
            { name: 'write', input: { path: '/c' }, result: 'ok' },
          ],
        },
      ],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });

    const msgs = mkCreate.mock.lastCall[0].messages;

    // Turn 0: assistant with 2 tool_calls
    expect(msgs[1].tool_calls[0].id).toBe('call_0_0');
    expect(msgs[1].tool_calls[1].id).toBe('call_0_1');
    // Turn 0: 2 tool results with matching IDs
    expect(msgs[2].tool_call_id).toBe('call_0_0');
    expect(msgs[3].tool_call_id).toBe('call_0_1');

    // Turn 1: assistant with 1 tool_call
    expect(msgs[4].tool_calls[0].id).toBe('call_1_0');
    // Turn 1: 1 tool result with matching ID
    expect(msgs[5].tool_call_id).toBe('call_1_0');
  });

  it('omits max_completion_tokens (no token cap; wall-clock + cost are the only worker bounds)', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIChatAdapter({ apiKey: 'k', model: 'gpt-5' });
    await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(mkCreate.mock.lastCall[0].max_completion_tokens).toBeUndefined();
  });
});
