// Per-request pipeline: body cap → route match → loopback guard → auth →
// decompress → JSON parse → cwd validation → handler dispatch.
import type { ServerConfig } from '@zhixuan92/multi-model-agent-core';
import { RouteDispatcher } from '@zhixuan92/multi-model-agent-core';
import { sendError } from './errors.js';
import { readBody } from './middleware/body-reader.js';
import { decompressBody } from './middleware/decompress.js';
import { validateAuthHeader } from './auth.js';
import { validateCwd } from './cwd-validator.js';
import { isLoopbackAddress, isAllowedHostHeader } from '@zhixuan92/multi-model-agent-core';
import { resolveCallerIdentity } from './middleware/caller-identity.js';
import type { RequestContext, RawHandler } from './types.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Daemon-wide draining flag — set true by the cleanupSignal handler when
// SIGTERM/SIGINT fires. New dispatches refuse with 503 service_unavailable
// while shutdown drains in-flight tasks. /health is allowed through so
// operators can confirm the daemon is winding down.
let drainingMode = false;
export function setDraining(d: boolean): void { drainingMode = d; }
export function isDraining(): boolean { return drainingMode; }

/** Minimal structural view of the Bun server — only the client-IP lookup is needed. */
export interface RequestIPProvider {
  requestIP(req: Request): { address: string } | null;
}

export interface PipelineConfig {
  loopbackOnlyPaths: ReadonlySet<string>;
  authExemptPaths: ReadonlySet<string>;
  cwdRequiredPaths: ReadonlySet<string>;
  /** Routes that REQUIRE X-MMA-Main-Model header. Tool dispatches must
   *  attribute to a main model so wire telemetry's main_model is never null. */
  mainModelRequiredPaths: ReadonlySet<string>;
}

export async function handleRequest(
  router: RouteDispatcher<RawHandler>,
  token: string,
  req: Request,
  cfg: ServerConfig,
  pipelineCfg: PipelineConfig,
  server: RequestIPProvider,
): Promise<Response> {
  const method = req.method ?? 'GET';
  // Bun.serve always provides an absolute req.url; the base fallback keeps the
  // pipeline robust to unit tests that pass a path-only Request.
  const urlObj = new URL(req.url, 'http://localhost');
  const pathname = urlObj.pathname;

  // ── Step 0: draining check ────────────────────────────────────────────────
  if (drainingMode && !pathname.startsWith('/health')) {
    return sendError(503, 'service_unavailable', 'daemon is draining; retry after restart');
  }

  // ── Step 1: Body size cap ──────────────────────────────────────────────────
  let rawBody: Buffer | undefined;
  if (BODY_METHODS.has(method)) {
    const result = await readBody(req, cfg.server.limits.maxBodyBytes);
    if (!result.ok) {
      return new Response(
        JSON.stringify({ error: { code: 'payload_too_large', message: `Request body exceeds the ${cfg.server.limits.maxBodyBytes}-byte limit` } }),
        { status: 413, headers: { 'content-type': 'application/json', 'connection': 'close' } },
      );
    }
    rawBody = result.body;
  }

  // ── Step 2: Route match ────────────────────────────────────────────────────
  const match = router.match(method, pathname);
  if (!match) {
    const allowed = router.methodsFor(pathname);
    if (allowed.length > 0) {
      return sendError(405, 'method_not_allowed', `Method ${method} not allowed`, { allowed });
    }
    return sendError(404, 'not_found', `Unknown path ${pathname}`);
  }

  // ── Step 3: Loopback & rebinding guard ─────────────────────────────────────
  // (a) Host-header rebinding check — ALL routes.
  if (!isAllowedHostHeader(req.headers.get('host') ?? undefined)) {
    return sendError(403, 'forbidden_host', 'Request Host header is not an allowed loopback host');
  }
  // (b) IP-level loopback check — loopbackOnlyPaths only.
  if (pipelineCfg.loopbackOnlyPaths.has(pathname)) {
    const remoteAddr = server.requestIP(req)?.address;
    if (!isLoopbackAddress(remoteAddr ?? undefined)) {
      return sendError(403, 'loopback_only', 'This endpoint is only accessible from the loopback interface');
    }
  }

  // ── Step 4: Bearer auth ────────────────────────────────────────────────────
  if (!pipelineCfg.authExemptPaths.has(pathname)) {
    const authResult = validateAuthHeader(req.headers.get('authorization') ?? undefined, token);
    if (!authResult.ok) {
      return sendError(401, 'unauthorized', 'Valid Bearer token required');
    }
  }

  // ── Step 5: Decompress body ─────────────────────────────────────────────────
  if (rawBody !== undefined && rawBody.length > 0) {
    const enc = req.headers.get('content-encoding') ?? undefined;
    if (enc !== undefined) {
      const result = await decompressBody(rawBody, enc, {
        maxDecompressedBytes: cfg.server.limits.maxBodyBytes,
      });
      if (!result.ok) {
        return sendError(result.statusCode, result.reason, result.message);
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
      return sendError(400, 'invalid_json', 'Request body is not valid JSON');
    }
  }

  // ── Step 7: cwd query param validation ─────────────────────────────────────
  let cwdValue: string | undefined;
  const requiresCwd = pipelineCfg.cwdRequiredPaths.has(pathname) ||
    pathname === '/context-blocks' ||
    /^\/context-blocks\//.test(pathname);

  if (requiresCwd) {
    const cwdParam = urlObj.searchParams.get('cwd') ?? undefined;
    const cwdResult = validateCwd(cwdParam);
    if (!cwdResult.ok) {
      const statusCode = cwdResult.error === 'forbidden_cwd' ? 403 : 400;
      return sendError(statusCode, cwdResult.error, cwdResult.message);
    }
    cwdValue = cwdResult.canonicalCwd;
  }

  // ── Step 8: Caller identity from headers ────────────────────────────────────
  const identity = resolveCallerIdentity(req.headers);

  if (pipelineCfg.mainModelRequiredPaths.has(pathname)) {
    if (identity.callerClient === 'other') {
      return sendError(
        400,
        'client_required',
        'X-MMA-Client header is required on tool routes. Set it to one of: claude-code, cursor, codex-cli, gemini-cli.',
      );
    }
    // Auto-detect was unreliable: the claude-agent-sdk used by our own
    // claude-tier workers writes JSONL files into the same project slug,
    // and the resolver would pick those up (e.g. haiku) as the "main"
    // model. The header must come from the calling client.
    if (!identity.mainModel) {
      return sendError(
        400,
        'main_model_required',
        'X-MMA-Main-Model header is required on tool routes. Set it to the calling agent\'s model id (e.g. claude-opus-4-7, gpt-5.4).',
      );
    }
  }

  // ── Step 9: Hand off to matched handler ────────────────────────────────────
  const ctx: RequestContext = {
    url: urlObj,
    cwd: cwdValue,
    body: parsedBody,
    authed: !pipelineCfg.authExemptPaths.has(pathname),
    callerClient: identity.callerClient,
    mainModel: identity.mainModel,
  };

  return await match.handler(match.params, ctx);
}
