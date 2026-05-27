import { describe, it, expect } from 'bun:test';
import { toolConfig } from '../../packages/core/src/tools/execute-plan/tool-config.js';

describe('execute-plan per-tool integration (4.3.0 pipeline-redesign)', () => {
  it('toolConfig agent type is "standard" (cheap implementer)', () => {
    expect(toolConfig.agentType).toBe('standard');
  });

  it('category is artifact_producing', () => {
    expect(toolConfig.category).toBe('artifact_producing');
  });
});
