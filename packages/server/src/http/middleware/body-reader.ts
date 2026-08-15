import type { IncomingMessage } from 'node:http';

type BodyReadResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: 'too_large' | 'read_error' };

/**
 * Reads the request body up to `maxBytes`.
 *
 * A socket error is reported as `read_error`, NOT as `too_large`. The failure type had only one
 * member, so the error path was forced to claim the body exceeded the limit — a client that
 * disconnected mid-upload, or any transport fault, was recorded and answered as an oversized
 * payload. That is the same misattribution the envelope layer removed when it split cancellation
 * out of `error`: a cause the operator did not have is worse than no cause at all.
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
      settle({ ok: false, reason: 'read_error' });
    });
  });
}
