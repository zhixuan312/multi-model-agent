import { inputSchema as delegateSchema } from '../../packages/core/src/tools/delegate/schema.js';
import { executePlanInputSchema } from '../../packages/core/src/tools/execute-plan/tool-config.js';
import { toolConfig as delegateConfig } from '../../packages/core/src/tools/delegate/tool-config.js';
import { toolConfig as executePlanConfig } from '../../packages/core/src/tools/execute-plan/tool-config.js';

describe('dispatch mode config + schema', () => {
  it('delegate config defaults to parallel and is caller-overridable', () => {
    expect(delegateConfig.dispatchMode).toBe('parallel');
    expect(delegateConfig.dispatchModeOverridable).toBe(true);
  });

  it('execute-plan config is serial and not overridable', () => {
    expect(executePlanConfig.dispatchMode).toBe('serial');
    expect(executePlanConfig.dispatchModeOverridable).toBe(false);
  });

  it('delegate schema accepts an execution override', () => {
    const r = delegateSchema.safeParse({ tasks: [{ prompt: 'x' }], execution: 'serial' });
    expect(r.success).toBe(true);
  });

  it('delegate schema rejects an unknown execution value', () => {
    const r = delegateSchema.safeParse({ tasks: [{ prompt: 'x' }], execution: 'bogus' });
    expect(r.success).toBe(false);
  });

  it('execute-plan schema rejects an execution field (strict)', () => {
    const r = executePlanInputSchema.safeParse({ filePaths: ['/p/plan.md'], execution: 'serial' });
    expect(r.success).toBe(false);
  });
});
