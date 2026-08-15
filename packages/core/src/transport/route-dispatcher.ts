/**
 * RouteDispatcher — match an incoming method+path to a registered handler.
 * Generic over the handler type so server and core reuse the same dispatcher
 * with their own context types.
 */

interface RouteEntry<H> {
  handler: H;
  paramNames: string[];
  regex: RegExp;
}

export class RouteDispatcher<H> {
  private routes = new Map<string, Map<string, RouteEntry<H>>>();

  register(method: string, path: string, handler: H): void {
    const paramNames: string[] = [];
    // Literal segments are ESCAPED before becoming a pattern. Replacing only `:param` left every
    // other regex metacharacter live, so a path like `/openapi.json` would also have matched
    // `/openapiXjson` — the `.` meaning "any character". No route registered today contains one,
    // which is exactly why this was worth fixing before one does: the failure is a silent
    // mis-route, not an error.
    const regexStr = path
      .split(/(:\w+)/)
      .map((part) => {
        const param = /^:(\w+)$/.exec(part);
        if (param) {
          paramNames.push(param[1]!);
          return '([^/]+)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('');
    const regex = new RegExp('^' + regexStr + '$');
    if (!this.routes.has(method)) this.routes.set(method, new Map());
    this.routes.get(method)!.set(path, { handler, paramNames, regex });
  }

  match(method: string, url: string): { handler: H; params: Record<string, string> } | null {
    const pathname = url.split('?')[0];
    for (const [, entry] of this.routes.get(method) ?? new Map<string, RouteEntry<H>>()) {
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

  /** Returns the full registered route manifest as method/path pairs. */
  listRoutes(): Array<{ method: string; path: string }> {
    const manifest: Array<{ method: string; path: string }> = [];
    for (const [method, entries] of this.routes) {
      for (const [path] of entries) {
        manifest.push({ method, path });
      }
    }
    return manifest;
  }
}
