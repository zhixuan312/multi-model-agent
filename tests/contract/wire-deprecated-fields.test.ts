import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TelemetryChannel } from '../../packages/core/src/channels/telemetry-channel.js';

const expected = JSON.parse(
  readFileSync('tests/contract/goldens/wire-deprecated-fields.json', 'utf8'),
);

describe('TelemetryChannel deprecated-fields constants', () => {
  it('every wire payload includes the four constants verbatim', async () => {
    const captured: any[] = [];
    const ch = new TelemetryChannel({ upload: async (p) => { captured.push(p); } });
    await ch.emitTaskBundle({ taskIndex: 0 });
    expect(captured[0]).toMatchObject(expected);
  });
});
