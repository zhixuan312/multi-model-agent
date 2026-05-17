import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

/**
 * Spec C1 HTTPListener — bind loopback, accept HTTP. Supports a graceful
 * shutdown state where new requests are rejected with 503 while in-flight
 * async batches complete and TelemetryUploader drains.
 *
 * The listener owns the socket lifecycle. Routing and request pipeline are
 * separate (RouteDispatcher + RequestPipeline). Wire them together in the
 * server boot, not here.
 */

export type HTTPRequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface HTTPListenerOptions {
  /** Bind address — must be a loopback interface in production (127.0.0.1 or ::1). */
  bind: string;
  /** Listening port. Pass 0 for ephemeral allocation. */
  port: number;
  /** Application handler. Called for every accepted request unless draining. */
  handler: HTTPRequestHandler;
}

export class HTTPListener {
  private server: Server | null = null;
  private draining = false;
  private startedAt = 0;

  constructor(private readonly options: HTTPListenerOptions) {}

  async start(): Promise<{ port: number; address: string | null }> {
    const server = createServer((req, res) => {
      if (this.draining) {
        res.statusCode = 503;
        res.setHeader('Retry-After', '5');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'shutting_down', message: 'Server is shutting down' } }));
        return;
      }
      void this.options.handler(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(this.options.port, this.options.bind, resolve);
    });
    this.server = server;
    this.startedAt = Date.now();
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? (addr as { port: number }).port : this.options.port;
    const address = typeof addr === 'object' && addr !== null ? ((addr as { address?: string }).address ?? null) : null;
    return { port, address };
  }

  /** Begin graceful shutdown — new requests get 503; existing ones complete. */
  beginDraining(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** Wall-clock ms when the listener started. Zero if never started. */
  getStartedAt(): number {
    return this.startedAt;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }
}
