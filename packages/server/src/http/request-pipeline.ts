// Per-request pipeline: body cap → route match → loopback guard → auth →
// decompress → JSON parse → cwd validation → handler dispatch.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from '@zhixuan92/multi-model-agent-core';
import { Router } from './router.js';
import { sendError } from './errors.js';
import { readBody } from './middleware/body-reader.js';
import { decompressBody } from './middleware/decompress.js';
import { validateAuthHeader } from './auth.js';
import { validateCwd } from './cwd-validator.js';
import { isLoopbackAddress } from './loopback.js';
import { resolveCallerIdentity } from './middleware/caller-identity.js';
import type { RequestContext } from './types.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface PipelineConfig {
  loopbackOnlyPaths: ReadonlySet<string>;
  authExemptPaths: ReadonlySet<string>;
  cwdRequiredPaths: ReadonlySet<string>;
}

export async function handleRequest(
  router: Router,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
  pipelineCfg: PipelineConfig,
): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';

  // ── Step 1: Body size cap ──────────────────────────────────────────────────
  let rawBody: Buffer | undefined;
  if (BODY_METHODS.has(method)) {
    const result = await readBody(req, cfg.server.limits.maxBodyBytes);
    if (!result.ok) {
      res.writeHead(413, { 'content-type': 'application/json', 'connection': 'close' });
      res.end(
        JSON.stringify({ error: { code: 'payload_too_large', message: `Request body exceeds the ${cfg.server.limits.maxBodyBytes}-byte limit` } }),
        () => { req.socket?.destroy(); },
      );
      return;
    }
    rawBody = result.body;
  }

  // ── Step 2: Route match ────────────────────────────────────────────────────
  const match = router.match(method, rawUrl);
  if (!match) {
    const allowed = router.methodsFor(rawUrl);
    if (allowed.length > 0) {
      sendError(res, 405, 'method_not_allowed', `Method ${method} not allowed`, { allowed });
    } else {
      sendError(res, 404, 'not_found', `Unknown path ${rawUrl.split('?')[0]}`);
    }
    return;
  }

  // ── Step 3: Loopback guard ─────────────────────────────────────────────────
  const pathname = rawUrl.split('?')[0]!;
  if (pipelineCfg.loopbackOnlyPaths.has(pathname)) {
    const remoteAddr = req.socket?.remoteAddress;
    if (!isLoopbackAddress(remoteAddr)) {
      sendError(res, 403, 'loopback_only', 'This endpoint is only accessible from the loopback interface');
      return;
    }
  }

  // ── Step 4: Bearer auth ────────────────────────────────────────────────────
  if (!pipelineCfg.authExemptPaths.has(pathname)) {
    const header = req.headers['authorization'];
    const authResult = validateAuthHeader(header, token);
    if (!authResult.ok) {
      sendError(res, 401, 'unauthorized', 'Valid Bearer token required');
      return;
    }
  }

  // ── Step 5: Decompress body ─────────────────────────────────────────────────
  if (rawBody !== undefined && rawBody.length > 0) {
    const enc = req.headers['content-encoding'];
    if (enc !== undefined) {
      const result = await decompressBody(rawBody, enc, {
        maxDecompressedBytes: cfg.server.limits.maxBodyBytes,
      });
      if (!result.ok) {
        sendError(res, result.statusCode, result.reason, result.message);
        return;
      }
      rawBody = result.body;
    }
  }

  // ── Step 6: JSON body parse ────────────────────────────────────────────────
  let parsedBody: unknown;
  if (rawBody !== undefined && rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody.toString('utf8'));
    } catch {
      sendError(res, 400, 'invalid_json', 'Request body is not valid JSON');
      return;
    }
  }

  // ── Step 7: cwd query param validation ─────────────────────────────────────
  let cwdValue: string | undefined;
  const urlObj = new URL(rawUrl, 'http://localhost');
  const requiresCwd = pipelineCfg.cwdRequiredPaths.has(pathname) ||
    pathname === '/context-blocks' ||
    /^\/context-blocks\//.test(pathname);

  if (requiresCwd) {
    const cwdParam = urlObj.searchParams.get('cwd') ?? undefined;
    const cwdResult = validateCwd(cwdParam);
    if (!cwdResult.ok) {
      const statusCode = cwdResult.error === 'forbidden_cwd' ? 403 : 400;
      sendError(res, statusCode, cwdResult.error, cwdResult.message);
      return;
    }
    cwdValue = cwdResult.canonicalCwd;
  }

  // ── Step 8: Caller identity from headers ────────────────────────────────────
  const identity = resolveCallerIdentity(req);

  // ── Step 9: Hand off to matched handler ────────────────────────────────────
  const ctx: RequestContext = {
    url: urlObj,
    cwd: cwdValue,
    body: parsedBody,
    authed: !pipelineCfg.authExemptPaths.has(pathname),
    callerClient: identity.callerClient,
    callerSkill: identity.callerSkill,
  };

  await match.handler(req, res, match.params, ctx);
}
