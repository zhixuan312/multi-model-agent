// packages/server/src/http/handlers/introspection/tools-list.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { RawHandler } from '../../router.js';
import { buildOpenApiDoc, serializeOpenApiDoc } from '../../../openapi.js';

// Build the OpenAPI document once at handler-creation time (module-level lazy
// singleton pattern — no need to rebuild on every request).
let cachedDoc: Buffer | undefined;

function getDocBuffer(): Buffer {
  if (!cachedDoc) {
    const doc = buildOpenApiDoc();
    cachedDoc = Buffer.from(serializeOpenApiDoc(doc), 'utf8');
  }
  return cachedDoc;
}

/**
 * GET /tools — serves the OpenAPI 3.0 document describing all server endpoints.
 *
 * Auth is required (checked by the server pipeline) but this endpoint is NOT
 * loopback-gated — LAN clients can fetch the OpenAPI spec.
 */
export function buildToolsHandler(): RawHandler {
  return (_req: IncomingMessage, res: ServerResponse) => {
    const buf = getDocBuffer();
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(buf.byteLength),
    });
    res.end(buf);
  };
}
