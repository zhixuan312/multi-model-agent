/**
 * tests/executors/execute-plan-agent-type.test.ts
 *
 * 3.1.6 fix: executeExecutePlan previously hardcoded agentType='standard'
 * regardless of what the caller asked for. Now honors input.agentType.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { inputSchema } from '../../packages/core/src/tool-schemas/execute-plan.js';

describe('execute-plan input schema accepts agentType', () => {
  it('accepts agentType=standard', () => {
    const parsed = inputSchema.parse({
      tasks: ['1. setup'],
      filePaths: ['/tmp/plan.md'],
      agentType: 'standard',
    });
    expect(parsed.agentType).toBe('standard');
  });

  it('accepts agentType=complex', () => {
    const parsed = inputSchema.parse({
      tasks: ['1. setup'],
      filePaths: ['/tmp/plan.md'],
      agentType: 'complex',
    });
    expect(parsed.agentType).toBe('complex');
  });

  it('agentType is optional (undefined when omitted)', () => {
    const parsed = inputSchema.parse({
      tasks: ['1. setup'],
      filePaths: ['/tmp/plan.md'],
    });
    expect(parsed.agentType).toBeUndefined();
  });

  it('rejects invalid agentType values', () => {
    expect(() =>
      inputSchema.parse({
        tasks: ['1. setup'],
        filePaths: ['/tmp/plan.md'],
        agentType: 'mega',
      }),
    ).toThrow(z.ZodError);
  });
});
