import { describe, it, expect } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/execute-plan/tool-config.js';

describe('execute-plan per-tool integration (4.3.0 pipeline-redesign)', () => {
  it('toolConfig defines the new pipeline review templates', () => {
    expect(toolConfig.reviewTemplates).toBeDefined();
    expect(toolConfig.reviewTemplates?.spec).toBeDefined();
    expect(toolConfig.reviewTemplates?.qualityAP).toBeDefined();
  });

  it('toolConfig agent type is "standard" (cheap implementer)', () => {
    expect(toolConfig.agentType).toBe('standard');
  });

  it('category is artifact_producing', () => {
    expect(toolConfig.category).toBe('artifact_producing');
  });
});
