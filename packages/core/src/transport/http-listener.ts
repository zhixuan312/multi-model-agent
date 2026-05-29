/**
 * HTTPListener — owns the HTTP socket lifecycle on Bun.serve: bind a loopback
 * interface, accept connections, close on shutdown. Routing, draining policy,
 * auth, and request parsing live elsewhere (RouteDispatcher + request-pipeline).
 * The listener's only request-time responsibility is to convert a rejected
 * handler promise into a 500 response.
 */

/** The concrete server object Bun.serve returns (avoids the generic `Server<T>` param). */
export type BunServer = ReturnType<typeof Bun.serve>;

export type HTTPRequestHandler = (req: Request, server: BunServer) => Response | Promise<Response>;

export interface HTTPListenerOptions {
  /** Bind address — must be a loopback interface in production (127.0.0.1 or ::1). */
  bind: string;
  /** Listening port. Pass 0 for ephemeral allocation. */
  port: number;
  /** Application handler. Called for every accepted request. */
  handler: HTTPRequestHandler;
}

export class HTTPListener {
  private server: BunServer | null = null;

  constructor(private readonly options: HTTPListenerOptions) {}

  async start(): Promise<{ port: number; address: string | null }> {
    const handler = this.options.handler;
    const server = Bun.serve({
      port: this.options.port,
      hostname: this.options.bind,
      async fetch(req, srv) {
        try {
          return await handler(req, srv);
        } catch (err: unknown) {
          const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
          process.stderr.write(`[mmagent] listener handler rejected: ${msg}\n`);
          return new Response(
            JSON.stringify({ error: { code: 'internal_error', message: 'Internal server error' } }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          );
        }
      },
    });
    this.server = server;
    return { port: server.port ?? this.options.port, address: this.options.bind };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await this.server.stop(true);
    this.server = null;
  }
}
