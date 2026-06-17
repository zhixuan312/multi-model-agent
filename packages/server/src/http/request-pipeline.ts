// Per-request pipeline: body cap → route match → loopback guard → auth →
// decompress → JSON parse → cwd validation → handler dispatch.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from '@zhixuan92/multi-model-agent-core';
import type { RouteDispatcher } from '@zhixuan92/multi-model-agent-core';
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
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
  pipelineCfg: PipelineConfig,
): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';

  // ── Step 0: draining check ────────────────────────────────────────────────
  // Once SIGTERM/SIGINT fires and cleanupSignal calls setDraining(true), new
  // dispatches refuse with 503 so in-flight tasks can drain cleanly. /health
  // stays available so operators can confirm the daemon is winding down.
  if (drainingMode && !rawUrl.startsWith('/health')) {
    sendError(res, 503, 'service_unavailable', 'daemon is draining; retry after restart');
    return;
  }

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

  // ── Step 3: Loopback & rebinding guard ─────────────────────────────────────
  const pathname = rawUrl.split('?')[0]!;
  // (a) Host-header rebinding check — ALL routes. Defends against DNS rebinding:
  // the connection is loopback (IP check passes) but the Host header is an
  // attacker-controlled domain. Only literal loopback host forms are allowed.
  if (!isAllowedHostHeader(req.headers.host)) {
    sendError(res, 403, 'forbidden_host', 'Request Host header is not an allowed loopback host');
    return;
  }
  // (b) IP-level loopback check — loopbackOnlyPaths only.
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

  if (pipelineCfg.mainModelRequiredPaths.has(pathname)) {
    if (identity.callerClient === 'other') {
      sendError(
        res,
        400,
        'client_required',
        'X-MMA-Client header is required on tool routes. Set it to one of: claude-code, cursor, codex-cli, gemini-cli.',
      );
      return;
    }
    // Auto-detect was unreliable: the claude-agent-sdk used by our own
    // claude-tier workers writes JSONL files into the same project slug,
    // and the resolver would pick those up (e.g. haiku) as the "main"
    // model. The header must come from the calling client.
    if (!identity.mainModel) {
      sendError(
        res,
        400,
        'main_model_required',
        'X-MMA-Main-Model header is required on tool routes. Set it to the calling agent\'s model id (e.g. claude-opus-4-7, gpt-5.4).',
      );
      return;
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

  const t0 = Date.now();
  await match.handler(req, res, match.params, ctx);
  const ms = Date.now() - t0;
  process.stderr.write(`[mma] ${method} ${pathname} ${res.statusCode} ${ms}ms\n`);
}
