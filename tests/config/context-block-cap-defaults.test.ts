import { describe, it, expect } from 'vitest';
import { multiModelConfigSchema } from '../../packages/core/src/config/schema.js';

describe('server.limits cap defaults', () => {
  it('maxContextBlocksPerProject default bumped to 500 (was 32 in 4.2.1)', () => {
    const parsed = multiModelConfigSchema.parse({
      agents: { standard: { type: 'codex', model: 'x' }, complex: { type: 'codex', model: 'y' } },
    });
    expect(parsed.server.limits.maxContextBlocksPerProject).toBe(500);
  });

  it('maxContextBlockBytes default unchanged (512 KiB)', () => {
    const parsed = multiModelConfigSchema.parse({
      agents: { standard: { type: 'codex', model: 'x' }, complex: { type: 'codex', model: 'y' } },
    });
    expect(parsed.server.limits.maxContextBlockBytes).toBe(524_288);
  });

  it('accepts overrides for both new and existing caps', () => {
    const parsed = multiModelConfigSchema.parse({
      agents: { standard: { type: 'codex', model: 'x' }, complex: { type: 'codex', model: 'y' } },
      server: { limits: { maxContextBlocksPerProject: 50 } },
    });
    expect(parsed.server.limits.maxContextBlocksPerProject).toBe(50);
    // unchanged caps still carry their defaults when omitted
    expect(parsed.server.limits.maxContextBlockBytes).toBe(524_288);
  });

});
