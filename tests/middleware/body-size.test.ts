import { describe, it, expect } from 'vitest';
import { COMPRESSED_BODY_LIMIT_BYTES, DECOMPRESSED_BODY_LIMIT_BYTES } from '../../packages/server/src/http/middleware/body-size.js';
import { startTestServer } from '../helpers/test-server.js';

describe('body-size middleware', () => {
  describe('constants', () => {
    it('COMPRESSED_BODY_LIMIT_BYTES is 256 KiB', () => {
      expect(COMPRESSED_BODY_LIMIT_BYTES).toBe(256 * 1024);
    });

    it('DECOMPRESSED_BODY_LIMIT_BYTES is 2 MiB', () => {
      expect(DECOMPRESSED_BODY_LIMIT_BYTES).toBe(2 * 1024 * 1024);
    });
  });

  describe('integration', () => {
    it('413 when raw body exceeds compressed cap (256 KiB)', async () => {
      const s = await startTestServer({ server: { limits: { maxBodyBytes: COMPRESSED_BODY_LIMIT_BYTES } } });
      try {
        const big = 'x'.repeat(COMPRESSED_BODY_LIMIT_BYTES + 1);
        const res = await fetch(`${s.url}/delegate?cwd=/tmp`, { method: 'POST', body: big });
        expect(res.status).toBe(413);
        const body = await res.json();
        expect(body.error.code).toBe('payload_too_large');
      } finally {
        await s.stop();
      }
    });

    it('passes when body is within compressed cap', async () => {
      const s = await startTestServer({ server: { limits: { maxBodyBytes: COMPRESSED_BODY_LIMIT_BYTES } } });
      try {
        const small = JSON.stringify({ prompt: 'hello' });
        const res = await fetch(`${s.url}/delegate?cwd=/tmp`, {
          method: 'POST',
          body: small,
          headers: { Authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
        });
        expect(res.status).not.toBe(413);
        const body = await res.json();
        expect(body.error).toBeDefined();
        expect(body.error.code).toBe('no_agent_config');
      } finally {
        await s.stop();
      }
    });
  });
});
