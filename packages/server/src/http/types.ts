import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CallerClient, CallerSkill } from './middleware/caller-identity.js';

export interface RequestContext {
  url: URL;
  cwd?: string;       // set by cwd-validator middleware when required
  body?: unknown;     // set by body-reader middleware on POST/PATCH/DELETE
  authed: boolean;
  callerClient: CallerClient;
  callerSkill: CallerSkill;
}

export type Handler = (ctx: RequestContext, res: ServerResponse, params: Record<string, string>) => Promise<void> | void;
