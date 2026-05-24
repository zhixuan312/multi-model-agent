import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { normalize } from '../serializer/index.js';
import okGolden from '../goldens/endpoints/journal-ok.json' with { type: 'json' };

describe('contract: POST /journal lifecycle', () => {
  it('valid body dispatches task and returns ok envelope', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(
        `${h.baseUrl}/journal?cwd=${encodeURIComponent(process.cwd())}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
            Authorization: `Bearer ${h.token}`,
          },
          body: JSON.stringify({ learning: 'x'.repeat(25), tagHints: ['journal'] }),
        },
      );
      expect(res.status).toBe(202);
      const { batchId } = (await res.json()) as { batchId: string };
      expect(typeof batchId).toBe('string');

      let terminal: Response | null = null;
      for (let i = 0; i < 30; i++) {
        const poll = await fetch(`${h.baseUrl}/batch/${batchId}`, {
          headers: {
            "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
            Authorization: `Bearer ${h.token}`,
          },
        });
        if (poll.status === 200) {
          terminal = poll;
          break;
        }
        expect(poll.status).toBe(202);
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(terminal).not.toBeNull();
      const body = await terminal!.json() as Record<string, unknown>;
      expect(normalize(body)).toEqual(okGolden);
    } finally {
      await h.close();
    }
  });
});
