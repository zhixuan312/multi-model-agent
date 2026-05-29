import { describe, it, expect } from 'bun:test';
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

  it('covers all 12 kinds in PlainLogKindEnum', () => {
    expect(PlainLogKindEnum.options).toHaveLength(12);
  });
});
