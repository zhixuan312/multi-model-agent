import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from '@zhixuan92/multi-model-agent-core';
import { Router } from './router.js';
import { sendError, sendJson } from './errors.js';
import { readBody } from './middleware/body-reader.js';
import { loadToken, validateAuthHeader } from './auth.js';
import { validateCwd } from './cwd-validator.js';
import { isLoopbackAddress } from './loopback.js';

export interface RunningServer {
  port: number;
  stop(): Promise<void>;
}

/** Routes where the loopback guard is enforced. */
const LOOPBACK_ONLY_PATHS = new Set(['/health', '/status']);

/** Routes that do NOT require bearer auth. */
const AUTH_EXEMPT_PATHS = new Set(['/health']);

/** Routes that require a `cwd` query parameter (validated by cwd-validator middleware). */
const CWD_REQUIRED_PATHS = new Set(['/delegate', '/audit', '/review', '/verify', '/debug', '/execute-plan', '/retry']);

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const token = loadToken(config.server.auth.tokenFile);

  const router = new Router();

  // GET /health — lightweight liveness probe
  router.register('GET', '/health', (_req, res, _params) => {
    sendJson(res, 200, { ok: true });
  });

  // POST /delegate stub — returns 501 so the router knows this path has a registered method.
  // Real handler is wired in Phase 6. This stub lets Task 5.2 405/401 tests hit a live route.
  router.register('POST', '/delegate', (_req, res, _params) => {
    sendError(res, 501, 'not_implemented', 'POST /delegate handler not yet implemented');
  });

  const server = createServer((req, res) => {
    void handleRequest(router, token, req, res, config);
  });

  await new Promise<void>((resolve) => {
    server.listen(config.server.port, config.server.bind, resolve);
  });

  const addr = server.address();
  const port = (addr as { port: number }).port;

  return {
    port,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function handleRequest(
  router: Router,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';

  // ── Step 1: Body size cap (for methods that carry a body) ──────────────────
  let rawBody: Buffer | undefined;
  if (BODY_METHODS.has(method)) {
    const result = await readBody(req, cfg.server.limits.maxBodyBytes);
    if (!result.ok) {
      // Send 413 then close; include Connection: close so the client knows
      res.writeHead(413, { 'content-type': 'application/json', 'connection': 'close' });
      res.end(
        JSON.stringify({ error: { code: 'payload_too_large', message: `Request body exceeds the ${cfg.server.limits.maxBodyBytes}-byte limit` } }),
        () => { req.socket?.destroy(); },
      );
      return;
    }
    rawBody = result.body;
  }

  // ── Step 2: Route match (404 not_found / 405 method_not_allowed) ──────────
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

  // ── Step 3: Loopback guard for /health and /status ────────────────────────
  const pathname = rawUrl.split('?')[0];
  if (LOOPBACK_ONLY_PATHS.has(pathname)) {
    const remoteAddr = req.socket?.remoteAddress;
    if (!isLoopbackAddress(remoteAddr)) {
      sendError(res, 403, 'loopback_only', 'This endpoint is only accessible from the loopback interface');
      return;
    }
  }

  // ── Step 4: Auth (bearer token) — skip for /health ───────────────────────
  if (!AUTH_EXEMPT_PATHS.has(pathname)) {
    const header = req.headers['authorization'];
    const authResult = validateAuthHeader(header, token);
    if (!authResult.ok) {
      sendError(res, 401, 'unauthorized', 'Valid Bearer token required');
      return;
    }
  }

  // ── Step 5: JSON parse → ctx.body ────────────────────────────────────────
  let parsedBody: unknown;
  if (rawBody !== undefined && rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody.toString('utf8'));
    } catch {
      sendError(res, 400, 'invalid_json', 'Request body is not valid JSON');
      return;
    }
  }

  // ── Step 6: cwd query param → validate → ctx.cwd ─────────────────────────
  let cwdValue: string | undefined;
  const urlObj = new URL(rawUrl, 'http://localhost');
  if (CWD_REQUIRED_PATHS.has(pathname)) {
    const cwdParam = urlObj.searchParams.get('cwd') ?? undefined;
    const cwdResult = validateCwd(cwdParam);
    if (!cwdResult.ok) {
      const statusCode = cwdResult.error === 'forbidden_cwd' ? 403 : 400;
      sendError(res, statusCode, cwdResult.error, cwdResult.message);
      return;
    }
    cwdValue = cwdResult.canonicalCwd;
  }

  // ── Steps 7-9: Zod validation, project registry, and handler run ──────────
  // These happen inside each handler (Phase 6+).
  const ctx = {
    url: urlObj,
    cwd: cwdValue,
    body: parsedBody,
    authed: !AUTH_EXEMPT_PATHS.has(pathname),
  };

  await match.handler(req, res, match.params);
}
