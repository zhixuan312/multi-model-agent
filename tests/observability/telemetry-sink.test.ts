import { describe, it, expect, vi } from 'vitest';
import { TelemetrySink } from '../../packages/core/src/observability/telemetry-sink.js';

describe('TelemetrySink', () => {
  it('forwards cloud events to recorder.enqueue', () => {
    const enqueue = vi.fn();
    const sink = new TelemetrySink({ enqueue } as any);
    sink.emit({ event: 'task.completed', ts: '2026-04-27T00:00:00Z' } as any);
    expect(enqueue).toHaveBeenCalled();
  });

  it('drops non-cloud events', () => {
    const enqueue = vi.fn();
    const sink = new TelemetrySink({ enqueue } as any);
    sink.emit({ event: 'heartbeat' } as any);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('drops everything when recorder is null (diagnostics off)', () => {
    const sink = new TelemetrySink(null);
    expect(() => sink.emit({ event: 'task.completed' } as any)).not.toThrow();
  });
});
