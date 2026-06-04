import type { IncomingMessage } from 'node:http';

export type BodyReadResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: 'too_large' };

/**
 * Reads the request body up to `maxBytes`.
 * If the body exceeds `maxBytes`, drains remaining data and resolves with
 * { ok: false, reason: 'too_large' } so the server can still send a 413 response
 * before closing the connection.
 */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let overflow = false;

    function settle(result: BodyReadResult) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    req.on('data', (chunk: Buffer) => {
      if (overflow) {
        // Drain remaining data silently after overflow is detected
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        // Don't push this chunk; signal overflow and continue draining
        settle({ ok: false, reason: 'too_large' });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!overflow) {
        settle({ ok: true, body: Buffer.concat(chunks) });
      }
      // If overflow, already settled — no-op
    });

    req.on('error', () => {
      settle({ ok: false, reason: 'too_large' });
    });
  });
}
