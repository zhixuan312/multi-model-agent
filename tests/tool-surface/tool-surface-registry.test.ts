import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolSurfaceRegistry } from '../../packages/core/src/tool-surface/tool-surface-registry.js';

describe('ToolSurfaceRegistry', () => {
  it('registers + retrieves entries', () => {
    const r = new ToolSurfaceRegistry();
    r.register({
      routeName: 'delegate',
      schema: z.object({}),
      toolCategory: 'artifact_producing',
      agentTypeDefault: 'standard',
      agentTypeOverridable: true,
      responseShapeName: 'BatchResponse',
    });
    expect(r.get('delegate')?.toolCategory).toBe('artifact_producing');
  });

  it('throws on duplicate registration', () => {
    const r = new ToolSurfaceRegistry();
    r.register({
      routeName: 'x',
      schema: z.object({}),
      toolCategory: 'read_only',
      agentTypeDefault: 'complex',
      agentTypeOverridable: false,
      responseShapeName: 'X',
    });
    expect(() =>
      r.register({
        routeName: 'x',
        schema: z.object({}),
        toolCategory: 'read_only',
        agentTypeDefault: 'complex',
        agentTypeOverridable: false,
        responseShapeName: 'X',
      }),
    ).toThrow(/already registered/);
  });
});
