import { describe, it, expect } from 'vitest';
import { buildWirePayload } from '../../packages/core/src/telemetry/event-builder.js';
import { WireTelemetryRecordSchema } from '../../packages/core/src/telemetry/types.js';

describe('TelemetryChannel wire-translation', () => {
  it('translates mainModel* to parentModel* on the wire', () => {
    const internal = {
      mainModel: 'claude-sonnet-4-5',
      mainModelFamily: 'claude' as const,
    };
    const wire = buildWirePayload(internal);
    expect(wire.parentModel).toBe('claude-sonnet-4-5');
    expect(wire.parentModelFamily).toBe('claude');
    expect((wire as any).mainModel).toBeUndefined();
    expect((wire as any).mainModelFamily).toBeUndefined();
  });

  it('wire payload validates against WireTelemetryRecord schema', () => {
    const internal = {
      mainModel: 'claude-sonnet-4-5',
      mainModelFamily: 'claude' as const,
    };
    const wire = buildWirePayload(internal);
    const result = WireTelemetryRecordSchema.safeParse(wire);
    expect(result.success).toBe(true);
  });

  it('preserves passthrough fields from the internal record', () => {
    const internal = {
      mainModel: 'claude-opus-4-7',
      mainModelFamily: 'claude' as const,
      eventId: '550e8400-e29b-41d4-a716-446655440000',
      route: 'delegate',
      customField: 42,
    };
    const wire = buildWirePayload(internal);
    expect((wire as any).eventId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect((wire as any).route).toBe('delegate');
    expect((wire as any).customField).toBe(42);
  });

  it('handles null mainModel gracefully', () => {
    const wire = buildWirePayload({
      mainModel: null,
      mainModelFamily: 'other' as const,
    });
    expect(wire.parentModel).toBeNull();
    expect(wire.parentModelFamily).toBe('other');
  });
});
