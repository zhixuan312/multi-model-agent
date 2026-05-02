import { describe, expect, it } from 'vitest';
import type { TaskSpec } from '../../packages/core/src/types.js';
import type { ResearchToolDefinition } from '../../packages/core/src/research/types.js';

describe('TaskSpec.customToolset', () => {
  it('accepts undefined', () => {
    const ts: TaskSpec = { prompt: 'hi' };
    expect(ts.customToolset).toBeUndefined();
  });

  it('accepts an array of ResearchToolDefinition', () => {
    const tool: ResearchToolDefinition = {
      name: 'web_fetch',
      description: 'Fetch a URL',
      inputSchema: {},
      invoke: async () => undefined,
    };
    const ts: TaskSpec = { prompt: 'hi', customToolset: [tool] };
    expect(ts.customToolset?.length).toBe(1);
  });
});
