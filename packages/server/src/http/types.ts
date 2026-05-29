import type { CallerClient } from './middleware/caller-identity.js';

export interface RequestContext {
  url: URL;
  cwd?: string;       // set by cwd-validator middleware when required
  body?: unknown;     // set by body-reader middleware on POST/PATCH/DELETE
  authed: boolean;
  callerClient: CallerClient;
  /** Calling agent's model id from x-mma-main-model header (null if absent). */
  mainModel: string | null;
}

/**
 * Handler shape registered on the C1 RouteDispatcher inside the server.
 * Under Bun.serve, handlers receive the matched route params + the request
 * context (caller identity, cwd, parsed body, url) and RETURN a Web `Response`.
 */
export type RawHandler = (
  params: Record<string, string>,
  ctx: RequestContext,
) => Promise<Response> | Response;
