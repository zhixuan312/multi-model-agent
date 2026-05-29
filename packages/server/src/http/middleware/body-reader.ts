export type BodyReadResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: 'too_large' };

/**
 * Reads the request body up to `maxBytes`.
 * Bun buffers the body; we read it whole and enforce the cap on byte length.
 * Returns { ok: false, reason: 'too_large' } when the body exceeds the cap so
 * the pipeline can still send a 413 before closing.
 */
export async function readBody(req: Request, maxBytes: number): Promise<BodyReadResult> {
  try {
    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.byteLength > maxBytes) return { ok: false, reason: 'too_large' };
    return { ok: true, body: buf };
  } catch {
    return { ok: false, reason: 'too_large' };
  }
}
