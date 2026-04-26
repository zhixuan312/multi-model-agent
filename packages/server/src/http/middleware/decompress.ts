import { createGunzip } from 'node:zlib';

export interface DecompressOpts {
  maxDecompressedBytes: number;
}

export type DecompressResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: 'too_large' | 'unsupported_encoding' | 'decompress_error'; statusCode: number; message: string };

export function decompressBody(
  rawBody: Buffer,
  contentEncoding: string | undefined,
  opts: DecompressOpts,
): Promise<DecompressResult> {
  const enc = (contentEncoding ?? '').toLowerCase().trim();

  if (enc === '' || enc === 'identity') {
    if (rawBody.byteLength > opts.maxDecompressedBytes) {
      return Promise.resolve({
        ok: false,
        reason: 'too_large',
        statusCode: 413,
        message: `Request body exceeds the ${opts.maxDecompressedBytes}-byte limit`,
      });
    }
    return Promise.resolve({ ok: true, body: rawBody });
  }

  if (enc === 'gzip') {
    return streamGunzip(rawBody, opts.maxDecompressedBytes).then(
      (data) => ({ ok: true, body: data }),
      (e: Error & { statusCode?: number }) => {
        if (e.statusCode === 413) {
          return { ok: false, reason: 'too_large', statusCode: 413, message: 'Decompressed body exceeds size cap' };
        }
        return { ok: false, reason: 'decompress_error', statusCode: 400, message: `gzip decompression failed: ${e.message}` };
      },
    );
  }

  return Promise.resolve({
    ok: false,
    reason: 'unsupported_encoding',
    statusCode: 415,
    message: `Unsupported content-encoding: ${enc}`,
  });
}

function streamGunzip(buf: Buffer, capBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gz = createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    gz.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > capBytes) {
        gz.destroy();
        const err: Error & { statusCode?: number } = new Error('decompressed body exceeds cap');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    gz.on('end', () => resolve(Buffer.concat(chunks)));
    gz.on('error', (e) => reject(e));
    gz.end(buf);
  });
}
