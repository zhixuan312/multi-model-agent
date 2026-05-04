import { describe, it, expect } from 'vitest';
import { TelemetryChannel } from '../../packages/core/src/channels/telemetry-channel.js';

describe('TelemetryChannel', () => {
  it('removes PII before upload', async () => {
    const uploaded: any[] = [];
    const ch = new TelemetryChannel({ upload: async (p) => { uploaded.push(p); } });
    await ch.emitTaskBundle({ userMessage: 'secret', assistantText: 'leak', taskIndex: 0 });
    expect(uploaded[0]).not.toHaveProperty('userMessage');
    expect(uploaded[0]).not.toHaveProperty('assistantText');
    expect(uploaded[0].taskIndex).toBe(0);
  });

  it('emits deprecated-fields constants', async () => {
    const uploaded: any[] = [];
    const ch = new TelemetryChannel({ upload: async (p) => { uploaded.push(p); } });
    await ch.emitTaskBundle({ taskIndex: 0 });
    expect(uploaded[0].capabilities).toEqual([]);
    expect(uploaded[0].clarificationRequested).toBe(false);
  });
});
