import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

/**
 * HTTPListener — owns the HTTP socket lifecycle: bind a loopback interface,
 * accept connections, close on shutdown. Routing, draining policy, auth, and
 * request parsing live elsewhere (RouteDispatcher + request-pipeline). The
 * listener's only request-time responsibility is to convert a rejected handler
 * promise into a 500 (when the response is still writable) or a log line.
 */

export type HTTPRequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/**
 * The port is already bound by something else.
 *
 * Raised instead of letting the socket's `error` event go unhandled. Without a
 * listener on that event Node turns EADDRINUSE into an uncaught exception, so
 * the single most common startup failure — a daemon is already running — was
 * reported as a stack trace, and a backgrounded start swallowed it entirely.
 * Callers catch this to name the port and, where they can determine it, the
 * process that owns it.
 */
export class PortInUseError extends Error {
  readonly code = 'EADDRINUSE';
  constructor(readonly bind: string, readonly port: number) {
    super(`${bind}:${port} is already in use`);
    this.name = 'PortInUseError';
  }
}

/**
 * What the socket does with an error raised AFTER a successful bind.
 *
 * Named and exported so its behaviour is testable directly. Node terminates the
 * process on an `error` event with no listener, so the point of this function is
 * that it exists at all and does not rethrow — a transient socket fault must not
 * take a daemon down mid-request.
 */
export function logLateSocketError(err: Error): void {
  process.stderr.write(`[mma] listener socket error: ${err.message}\n`);
}

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
        process.stderr.write(`[mma] listener handler rejected: ${msg}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'internal_error', message: 'Internal server error' } }));
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    });
    // Bind failures arrive as an `error` event, never as a callback argument, so
    // the listening callback alone cannot see them. Both events are registered
    // before listen() and each removes the other, so exactly one settles the
    // promise. After a successful bind the startup handler is replaced by a
    // logging one — the socket can still emit errors later, and an unhandled
    // 'error' event would take the whole daemon down.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        reject(err.code === 'EADDRINUSE' ? new PortInUseError(this.options.bind, this.options.port) : err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        server.on('error', logLateSocketError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.options.port, this.options.bind);
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
