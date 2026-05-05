import { describe, it, expect, vi } from 'vitest';
import { OpenAIResponsesAdapter } from '../../packages/core/src/providers/openai-responses-adapter.js';

const mkCreate = vi.fn();

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    responses: { create: mkCreate },
  })),
}));

function defaultResponse(overrides: Record<string, unknown> = {}) {
  return {
    usage: {
      input_tokens: 200,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 30 },
      output_tokens_details: { reasoning_tokens: 15 },
    },
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Hello from Responses API' }] },
    ],
    status: 'completed',
    ...overrides,
  };
}

describe('OpenAIResponsesAdapter', () => {
  it('maps Responses API usage to canonical 4-field shape with reasoning folded into outputTokens', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });
    const r = await a.turn({
      systemPrompt: 'You are helpful.',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.usage).toEqual({
      inputTokens: 200,
      outputTokens: 115, // output_tokens (100) + reasoning_tokens (15)
      cachedReadTokens: 30,
      cachedNonReadTokens: 0,
    });
    expect(r.finishReason).toBe('stop');
    expect(r.assistantText).toBe('Hello from Responses API');
  });

  it('infers finishReason tool_use when function_call items present in response.output', async () => {
    mkCreate.mockResolvedValue(defaultResponse({
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Using tool' }] },
        { type: 'function_call', call_id: 'fc_abc123', name: 'read', arguments: '{"path":"/x"}' },
      ],
    }));
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'read /x',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.finishReason).toBe('tool_use');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ id: 'fc_abc123', name: 'read', input: { path: '/x' } });
    expect(r.assistantText).toBe('Using tool');
  });

  it('infers finishReason max_tokens on incomplete status', async () => {
    mkCreate.mockResolvedValue(defaultResponse({
      status: 'incomplete',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'truncated' }] }],
    }));
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.finishReason).toBe('max_tokens');
  });

  it('infers finishReason max_tokens on cancelled status', async () => {
    mkCreate.mockResolvedValue(defaultResponse({
      status: 'cancelled',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
    }));
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.finishReason).toBe('max_tokens');
  });

  it('handles missing usage fields gracefully', async () => {
    mkCreate.mockResolvedValue({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      status: 'completed',
    });
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 });
    expect(r.finishReason).toBe('stop');
  });

  it('providerType is always codex', () => {
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'm', maxOutputTokens: 4096 });
    expect(a.providerType).toBe('codex');
  });

  it('sends instructions as the system prompt', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });
    await a.turn({
      systemPrompt: 'You are a helpful coding agent.',
      userMessage: 'read /etc/hosts',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    const callArgs = mkCreate.mock.lastCall[0];
    expect(callArgs.instructions).toBe('You are a helpful coding agent.');
  });

  it('builds input items with function_call and function_call_output pairs for prior turns', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });

    await a.turn({
      systemPrompt: '',
      userMessage: 'second message',
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
    const items = callArgs.input;
    expect(items).toHaveLength(4); // assistant, function_call, function_call_output, user

    // Assistant message
    expect(items[0]).toEqual({ role: 'assistant', content: 'I will read the file.' });

    // Function call item
    expect(items[1]).toMatchObject({
      type: 'function_call',
      call_id: 'call_0_0',
      name: 'read',
    });
    expect(JSON.parse(items[1].arguments)).toEqual({ path: '/etc/hosts' });

    // Function call output
    expect(items[2]).toEqual({
      type: 'function_call_output',
      call_id: 'call_0_0',
      output: '127.0.0.1 localhost',
    });

    // Current user message
    expect(items[3]).toEqual({ role: 'user', content: 'second message' });
  });

  it('stringifies non-string tool results in function_call_output', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });

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

    const items = mkCreate.mock.lastCall[0].input;
    expect(items[2].output).toBe('{"items":[1,2,3]}');
  });

  it('maps tool definitions to Responses API function format', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });

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
      { type: 'function', name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false },
    ]);
  });

  it('omits tools when toolDefinitions is empty', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });

    await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });

    const callArgs = mkCreate.mock.lastCall[0];
    expect(callArgs.tools).toBeUndefined();
  });

  it('wraps malformed JSON tool arguments instead of crashing', async () => {
    mkCreate.mockResolvedValue({
      usage: { input_tokens: 10, output_tokens: 5 },
      output: [
        { type: 'function_call', call_id: 'fc_bad', name: 'run', arguments: '{not valid json' },
      ],
      status: 'completed',
    });
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });
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

  it('uses deterministic tool_call_ids across prior turns', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });

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

    const items = mkCreate.mock.lastCall[0].input;

    // Turn 0: assistant, call_0, output_0, call_1, output_1
    expect(items[0]).toEqual({ role: 'assistant', content: 'turn 0' });
    expect(items[1]).toMatchObject({ type: 'function_call', call_id: 'call_0_0', name: 'read' });
    expect(items[2]).toMatchObject({ type: 'function_call_output', call_id: 'call_0_0' });
    expect(items[3]).toMatchObject({ type: 'function_call', call_id: 'call_0_1', name: 'read' });
    expect(items[4]).toMatchObject({ type: 'function_call_output', call_id: 'call_0_1' });

    // Turn 1: assistant, call_0, output_0
    expect(items[5]).toEqual({ role: 'assistant', content: 'turn 1' });
    expect(items[6]).toMatchObject({ type: 'function_call', call_id: 'call_1_0', name: 'write' });
    expect(items[7]).toMatchObject({ type: 'function_call_output', call_id: 'call_1_0' });

    // Final user message
    expect(items[8]).toEqual({ role: 'user', content: 'third turn' });
  });

  it('passes custom baseURL to OpenAI client', async () => {
    // Re-import to verify the constructor arg is passed through
    const OpenAI = await import('openai');
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIResponsesAdapter({
      apiKey: 'k', baseURL: 'https://chatgpt.com/backend-api/codex', model: 'gpt-5-codex', maxOutputTokens: 4096,
    });
    await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    // Verify the OpenAI constructor received baseURL
    expect(OpenAI.default).toHaveBeenCalledWith({
      apiKey: 'k',
      baseURL: 'https://chatgpt.com/backend-api/codex',
    });
  });

  it('sends max_output_tokens from constructor', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 8192 });
    await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(mkCreate.mock.lastCall[0].max_output_tokens).toBe(8192);
  });

  it('prior turn without assistantText still emits function_call pairs', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });

    await a.turn({
      systemPrompt: '',
      userMessage: 'next',
      priorTurns: [
        {
          assistantText: '',
          toolCalls: [
            { name: 'glob', input: { pattern: '*.ts' }, result: 'a.ts\nb.ts' },
          ],
        },
      ],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });

    const items = mkCreate.mock.lastCall[0].input;
    expect(items).toHaveLength(4); // assistant (empty content), function_call, function_call_output, user
    expect(items[0]).toEqual({ role: 'assistant', content: '' });
    expect(items[1].type).toBe('function_call');
    expect(items[2].type).toBe('function_call_output');
  });

  it('null tool result becomes "null" string in output', async () => {
    mkCreate.mockResolvedValue(defaultResponse());
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });

    await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [
        {
          assistantText: '',
          toolCalls: [
            { name: 'search', input: { q: 'x' }, result: null },
          ],
        },
      ],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });

    const items = mkCreate.mock.lastCall[0].input;
    expect(items[2].output).toBe('null');
  });

  it('extracts multiple output_text blocks from a message', async () => {
    mkCreate.mockResolvedValue({
      usage: { input_tokens: 50, output_tokens: 20 },
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'Part one. ' },
            { type: 'output_text', text: 'Part two.' },
          ],
        },
      ],
      status: 'completed',
    });
    const a = new OpenAIResponsesAdapter({ apiKey: 'k', model: 'gpt-5-codex', maxOutputTokens: 4096 });
    const r = await a.turn({
      systemPrompt: '',
      userMessage: 'hi',
      priorTurns: [],
      toolDefinitions: [],
      capabilities: { cache_control: false, thinking: false, vision: false, tool_use: true, streaming: false, other: [] },
    });
    expect(r.assistantText).toBe('Part one. Part two.');
  });
});
