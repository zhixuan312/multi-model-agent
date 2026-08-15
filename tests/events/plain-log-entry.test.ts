import { describe, it, expect } from 'vitest';
import { PlainLogEntrySchema, PlainLogKindEnum } from '../../packages/core/src/events/plain-log-entry.js';

describe('PlainLogEntrySchema', () => {
  it('accepts a valid entry', () => {
    const e = { ts: '2026-05-17T00:00:00Z', kind: 'batch_created' as const, fields: { batch_id: 'b1', route: 'delegate', cwd: '/tmp' } };
    expect(PlainLogEntrySchema.parse(e)).toEqual(e);
  });

  it('rejects unknown kind', () => {
    const e = { ts: '2026-05-17T00:00:00Z', kind: 'mystery' as never, fields: {} };
    expect(() => PlainLogEntrySchema.parse(e)).toThrow();
  });

  it('rejects object-valued field', () => {
    const e = { ts: '2026-05-17T00:00:00Z', kind: 'batch_created' as const, fields: { obj: { a: 1 } as unknown as string } };
    expect(() => PlainLogEntrySchema.parse(e)).toThrow();
  });

  // The kind list itself is checked by `plain-log-emitter-reachability.test.ts`, which requires
  // each name to have a production emitter. A `toHaveLength` assertion used to stand here and
  // was the reason eight emitterless kinds survived: a count cannot tell a live name from a
  // dead one, and it reads like coverage.
  it('rejects a kind that is spelled right but not declared', () => {
    expect(PlainLogKindEnum.options).not.toContain('request_received');
    const e = { ts: '2026-05-17T00:00:00Z', kind: 'request_received' as never, fields: {} };
    expect(() => PlainLogEntrySchema.parse(e)).toThrow();
  });
});
