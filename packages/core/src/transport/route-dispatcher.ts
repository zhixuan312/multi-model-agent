/**
 * Spec C1 RouteDispatcher — match incoming method+path to a handler.
 *
 * Routes declare their response shape (sync vs async-with-batchId) at
 * registration time via metadata; the dispatcher reads from registration
 * metadata, not from handler return shape. This lets the request pipeline
 * branch on shape without interpreting handler internals.
 *
 * Generic over the handler type so server and core both reuse the same
 * dispatcher mechanism with their own context types.
 */

export type ResponseShape = 'sync' | 'async-batch';

export interface RouteMetadata {
  /** Declared response shape for this route. Defaults to 'sync'. */
  responseShape?: ResponseShape;
}

interface RouteEntry<H> {
  handler: H;
  paramNames: string[];
  regex: RegExp;
  metadata: RouteMetadata;
}

export class RouteDispatcher<H> {
  private routes = new Map<string, Map<string, RouteEntry<H>>>();

  register(method: string, path: string, handler: H, metadata: RouteMetadata = {}): void {
    const paramNames: string[] = [];
    const regexStr = path.replace(/:(\w+)/g, (_, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    const regex = new RegExp('^' + regexStr + '$');
    if (!this.routes.has(method)) this.routes.set(method, new Map());
    this.routes.get(method)!.set(path, { handler, paramNames, regex, metadata });
  }

  match(method: string, url: string): { handler: H; params: Record<string, string>; metadata: RouteMetadata } | null {
    const pathname = url.split('?')[0];
    for (const [, entry] of this.routes.get(method) ?? new Map<string, RouteEntry<H>>()) {
      const m = pathname.match(entry.regex);
      if (m) {
        const params: Record<string, string> = {};
        entry.paramNames.forEach((n, i) => { params[n] = m[i + 1]; });
        return { handler: entry.handler, params, metadata: entry.metadata };
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

  /** Returns the full registered route manifest as method/path pairs. */
  listRoutes(): Array<{ method: string; path: string; metadata: RouteMetadata }> {
    const manifest: Array<{ method: string; path: string; metadata: RouteMetadata }> = [];
    for (const [method, entries] of this.routes) {
      for (const [path, entry] of entries) {
        manifest.push({ method, path, metadata: entry.metadata });
      }
    }
    return manifest;
  }
}
