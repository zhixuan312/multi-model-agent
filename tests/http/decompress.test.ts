import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { decompressBody } from '../../packages/server/src/http/middleware/decompress.js';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

describe('decompressBody (unit)', () => {
  const opts = { maxDecompressedBytes: 2 * 1024 * 1024 };

  it('inflates a gzip body back to original content', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const compressed = gzipSync(Buffer.from(body));
    const result = await decompressBody(compressed, 'gzip', opts);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.toString('utf8')).toBe(body);
    }
  });

  it('passes through identity encoding unchanged', async () => {
    const raw = Buffer.from(JSON.stringify({ a: 1 }));
    const result = await decompressBody(raw, 'identity', opts);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toBe(raw);
    }
  });

  it('passes through empty content-encoding unchanged', async () => {
    const raw = Buffer.from(JSON.stringify({ b: 2 }));
    const result = await decompressBody(raw, undefined, opts);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toBe(raw);
    }
  });

  it('returns 413 when decompressed body exceeds cap', async () => {
    const smallCap = { maxDecompressedBytes: 1024 };
    const big = 'x'.repeat(10_000);
    const compressed = gzipSync(Buffer.from(JSON.stringify({ s: big })));
    const result = await decompressBody(compressed, 'gzip', smallCap);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(413);
      expect(result.reason).toBe('too_large');
    }
  });

  it('returns 413 when raw body exceeds cap with no encoding', async () => {
    const smallCap = { maxDecompressedBytes: 10 };
    const big = Buffer.alloc(100, 'x');
    const result = await decompressBody(big, undefined, smallCap);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(413);
      expect(result.reason).toBe('too_large');
    }
  });

  it('returns 415 for unsupported content-encoding', async () => {
    const raw = Buffer.from('hello');
    const result = await decompressBody(raw, 'br', opts);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(415);
      expect(result.reason).toBe('unsupported_encoding');
    }
  });

  it('handles empty buffer with gzip encoding gracefully', async () => {
    const compressed = gzipSync(Buffer.from(''));
    const result = await decompressBody(compressed, 'gzip', opts);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.toString('utf8')).toBe('');
    }
  });

  it('rejects corrupt gzip data', async () => {
    const corrupt = Buffer.from('not gzip data');
    const result = await decompressBody(corrupt, 'gzip', opts);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('decompress_error');
      expect(result.statusCode).toBe(400);
    }
  });
});

describe('decompress pipeline integration', () => {
  it('decompresses gzip body through the full HTTP pipeline', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const body = JSON.stringify({ type: 'review', target: { paths: ['/tmp/gzip-test.ts'] } });
      const compressed = gzipSync(Buffer.from(body));
      const res = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${h.token}`,
        },
        body: compressed,
      });
      expect(res.status).toBe(202);
    } finally {
      await h.close();
    }
  });

  it('returns 400 for corrupt gzip body through HTTP', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${h.token}`,
        },
        body: Buffer.from('not gzip data'),
      });
      expect(res.status).toBe(400);
    } finally {
      await h.close();
    }
  });

  /**
   * The cap that stops a zip bomb has to be the CONFIGURED one.
   *
   * `decompressBody`'s unit cases pass a cap in by hand, so they hold whatever
   * `request-pipeline.ts` does with `cfg.server.limits.maxBodyBytes` — including nothing. The
   * default 10MB is large enough that every integration case here passes with the limit
   * hardcoded, ignored, or read from the wrong field. Sending 40KB of gzipped 'x' (about 100
   * bytes compressed) against a 4KB configured cap is only rejected if the config value is the
   * one being enforced.
   */
  it('enforces the CONFIGURED maxBodyBytes on a decompressed body, not a built-in default', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd(), limits: { maxBodyBytes: 4096 } });
    try {
      const bomb = JSON.stringify({ type: 'review', target: { inline: 'x'.repeat(40_000) } });
      const compressed = gzipSync(Buffer.from(bomb));
      expect(compressed.byteLength).toBeLessThan(4096); // the point: small on the wire, large inflated
      const res = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'X-MMA-Main-Model': 'claude-opus-4-7', 'X-MMA-Client': 'claude-code',
          Authorization: `Bearer ${h.token}`,
        },
        body: compressed,
      });
      expect(res.status).toBe(413);
    } finally {
      await h.close();
    }
  });

  it('returns 415 for unsupported content-encoding through HTTP', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const body = JSON.stringify({ type: 'review', target: { paths: ['/tmp/br-test.ts'] } });
      const res = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'br',
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${h.token}`,
        },
        body,
      });
      expect(res.status).toBe(415);
    } finally {
      await h.close();
    }
  });
});
