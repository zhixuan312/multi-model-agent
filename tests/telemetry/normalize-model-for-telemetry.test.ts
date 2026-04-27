import { describe, it, expect } from 'vitest';
import { normalizeModelForTelemetry } from '../../packages/core/src/telemetry/event-builder.js';

describe('normalizeModelForTelemetry', () => {
  it('returns input unchanged for valid IDs', () => {
    expect(normalizeModelForTelemetry('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(normalizeModelForTelemetry('llama2:7b')).toBe('llama2:7b');
    expect(normalizeModelForTelemetry('meta-llama/Llama-4-Maverick')).toBe('meta-llama/Llama-4-Maverick');
  });

  it("returns 'other' for null/undefined/empty", () => {
    expect(normalizeModelForTelemetry(null)).toBe('other');
    expect(normalizeModelForTelemetry(undefined)).toBe('other');
    expect(normalizeModelForTelemetry('')).toBe('other');
  });

  it("returns 'other' when input violates BoundedIdentifier shape", () => {
    expect(normalizeModelForTelemetry('model with spaces')).toBe('other');
    expect(normalizeModelForTelemetry('a'.repeat(121))).toBe('other');
    expect(normalizeModelForTelemetry('claude@beta')).toBe('other');
  });

  it("never throws on garbage input", () => {
    expect(normalizeModelForTelemetry('\x00\x01')).toBe('other');
  });
});
