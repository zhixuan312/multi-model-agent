import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

/**
 * HTTPListener — owns the HTTP socket lifecycle: bind a loopback interface,
 * accept connections, close on shutdown. Routing, draining policy, auth, and
 * request parsing live elsewhere (RouteDispatcher + request-pipeline). The
 * listener's only request-time responsibility is to convert a rejected handler
 * promise into a 500 (when the response is still writable) or a log line.
 */

export type HTTPRequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface HTTPListenerOptions {
  /** Bind address — must be a loopback interface in production (127.0.0.1 or ::1). */
  bind: string;
  /** Listening port. Pass 0 for ephemeral allocation. */
  port: number;
  /** Application handler. Called for every accepted request. */
  handler: HTTPRequestHandler;
}

export class HTTPListener {
  private server: Server | null = null;

  constructor(private readonly options: HTTPListenerOptions) {}

  async start(): Promise<{ port: number; address: string | null }> {
    const server = createServer((req, res) => {
      Promise.resolve(this.options.handler(req, res)).catch((err: unknown) => {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stderr.write(`[mmagent] listener handler rejected: ${msg}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'internal_error', message: 'Internal server error' } }));
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(this.options.port, this.options.bind, resolve);
    });
    this.server = server;
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? (addr as { port: number }).port : this.options.port;
    const address = typeof addr === 'object' && addr !== null ? ((addr as { address?: string }).address ?? null) : null;
    return { port, address };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }
}
