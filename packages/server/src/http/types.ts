import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestContext {
  url: URL;
  cwd?: string;       // set by cwd-validator middleware when required
  body?: unknown;     // set by body-reader middleware on POST/PATCH/DELETE
  authed: boolean;
}

export type Handler = (ctx: RequestContext, res: ServerResponse, params: Record<string, string>) => Promise<void> | void;
