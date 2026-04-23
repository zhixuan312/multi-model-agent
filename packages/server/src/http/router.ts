import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestContext } from './types.js';

export type RawHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: RequestContext) => Promise<void> | void;

interface RouteEntry {
  handler: RawHandler;
  paramNames: string[];
  regex: RegExp;
}

export class Router {
  private routes = new Map<string, Map<string, RouteEntry>>();

  register(method: string, path: string, handler: RawHandler): void {
    const paramNames: string[] = [];
    const regexStr = path.replace(/:(\w+)/g, (_, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    const regex = new RegExp('^' + regexStr + '$');
    if (!this.routes.has(method)) this.routes.set(method, new Map());
    this.routes.get(method)!.set(path, { handler, paramNames, regex });
  }

  match(method: string, url: string): { handler: RawHandler; params: Record<string, string> } | null {
    const pathname = url.split('?')[0];
    for (const [, entry] of this.routes.get(method) ?? new Map<string, RouteEntry>()) {
      const m = pathname.match(entry.regex);
      if (m) {
        const params: Record<string, string> = {};
        entry.paramNames.forEach((n, i) => { params[n] = m[i + 1]; });
        return { handler: entry.handler, params };
      }
    }
    return null;
  }

  /** Returns all HTTP methods registered for routes that match the given url pathname. */
  methodsFor(url: string): string[] {
    const pathname = url.split('?')[0];
    const methods: string[] = [];
    for (const [method, entries] of this.routes) {
      for (const [, entry] of entries) {
        if (entry.regex.test(pathname)) {
          methods.push(method);
          break;
        }
      }
    }
    return methods;
  }
}
