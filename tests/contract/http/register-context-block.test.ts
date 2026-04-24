import { describe, it, expect } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { normalize } from '../serializer/index.js';
import okGolden from '../goldens/endpoints/register-context-block-ok.json' with { type: 'json' };
import invalidGolden from '../goldens/endpoints/register-context-block-invalid.json' with { type: 'json' };

describe('contract: POST /context-blocks', () => {
  it('valid body returns 200 with golden shape', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(
        `${h.baseUrl}/context-blocks?cwd=${encodeURIComponent(process.cwd())}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${h.token}`,
          },
          body: JSON.stringify({ content: 'hello from context block' }),
        },
      );
      expect(res.status).toBe(201);
      expect(normalize(await res.json())).toEqual(okGolden);
    } finally {
      await h.close();
    }
  });

  it('empty body returns 400 error envelope', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(
        `${h.baseUrl}/context-blocks?cwd=${encodeURIComponent(process.cwd())}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${h.token}`,
          },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(400);
      expect(normalize(await res.json())).toEqual(invalidGolden);
    } finally {
      await h.close();
    }
  });
});