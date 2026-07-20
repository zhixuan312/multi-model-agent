import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CallerClient } from './middleware/caller-identity.js';

export interface RequestContext {
  url: URL;
  cwd?: string;       // set by cwd-validator middleware when required
  body?: unknown;     // set by body-reader middleware on POST/PATCH/DELETE
  callerClient: CallerClient;
  /** Calling agent's model id from x-mma-main-model header (null if absent). */
  mainModel: string | null;
}

/**
 * Raw handler shape used by the C1 RouteDispatcher inside the server.
 * Server-specific because it carries RequestContext (caller identity, cwd, body).
 * The core RouteDispatcher is generic; this is the concrete H instantiation
 * the server registers.
 */
export type RawHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  ctx: RequestContext,
) => Promise<void> | void;
