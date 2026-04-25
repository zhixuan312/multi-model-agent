import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { decompressBody } from '../../packages/server/src/http/middleware/decompress.js';

describe('decompressBody', () => {
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
