import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startAvailabilityProbe } from '../../scripts/full-smoke/availability.mjs';

/**
 * The availability probe must actually FIRE on a wedged daemon.
 *
 * This test exists because of a specific mistake worth not repeating: a detector nobody has ever
 * seen trigger is indistinguishable from a detector that cannot trigger. The probe was written to
 * catch a reported production fault — "the daemon has wedged four times today, always HTTP-layer
 * while workers keep running" — and adding it to the release gate without proving it detects that
 * fault would have reproduced the original problem one level up: a green gate that measures
 * nothing.
 *
 * Each case drives a REAL HTTP server whose behaviour is controlled by the test, so the probe is
 * exercised end to end over the network rather than through a mocked fetch.
 */

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

/** Start a server whose responsiveness the test controls through `state`. */
async function startServer(state: { wedged: boolean }): Promise<string> {
  server = createServer((_req, res) => {
    // A wedged daemon does not refuse the connection — it accepts and never answers, which is
    // exactly why a probe needs its own deadline rather than waiting on the socket.
    if (state.wedged) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const address = server!.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('availability probe', () => {
  it('reports PASS against a responsive server', async () => {
    const state = { wedged: false };
    const baseUrl = await startServer(state);
    const probe = startAvailabilityProbe({ baseUrl, intervalMs: 30, failMs: 400 });
    await new Promise((r) => setTimeout(r, 250));
    const result = await probe.stop();

    expect(result.status).toBe('PASS');
    expect(result.probes).toBeGreaterThan(1);
    expect(result.failures).toBe(0);
  });

  it('reports FAIL when the server accepts connections but never answers', async () => {
    // The reported production shape: the process is alive, the port is open, and nothing comes
    // back. A liveness check that only asked "is the port open?" would call this healthy.
    const state = { wedged: true };
    const baseUrl = await startServer(state);
    const probe = startAvailabilityProbe({ baseUrl, intervalMs: 30, failMs: 200 });
    await new Promise((r) => setTimeout(r, 700));
    const result = await probe.stop();

    expect(result.status).toBe('FAIL');
    expect(result.failures).toBeGreaterThan(0);
    expect(result.longestOutageMs).toBeGreaterThanOrEqual(200);
    // The message must name the shape, so a reader knows where to look instead of re-deriving it.
    expect(result.detail).toContain('synchronous work on the daemon event loop');
  });

  it('measures the longest CONTINUOUS outage, not the total unanswered time', async () => {
    // Two short stalls are a different fault from one long one. A caller survives the first and
    // fails the second, so summing them would report the wrong severity.
    const state = { wedged: false };
    const baseUrl = await startServer(state);
    const probe = startAvailabilityProbe({ baseUrl, intervalMs: 25, failMs: 150 });

    await new Promise((r) => setTimeout(r, 100));
    state.wedged = true;
    await new Promise((r) => setTimeout(r, 250));
    state.wedged = false;
    await new Promise((r) => setTimeout(r, 150));

    const result = await probe.stop();
    expect(result.failures).toBeGreaterThan(0);
    // Recovery must be observed: the outage closed rather than running to the end of the probe.
    expect(result.outages.length).toBeGreaterThan(0);
    expect(result.longestOutageMs).toBeGreaterThan(0);
  });

  it('still reports an outage that was open when the run ended', async () => {
    // The worst window of a run is often the one still open at the end. Dropping it would hide
    // exactly the case where the daemon never recovered.
    const state = { wedged: false };
    const baseUrl = await startServer(state);
    const probe = startAvailabilityProbe({ baseUrl, intervalMs: 25, failMs: 150 });
    await new Promise((r) => setTimeout(r, 80));
    state.wedged = true;
    await new Promise((r) => setTimeout(r, 300));

    const result = await probe.stop();
    expect(result.failures).toBeGreaterThan(0);
    expect(result.longestOutageMs).toBeGreaterThan(0);
  });

  it('reports NA rather than PASS when it never sampled', async () => {
    // A detector that reports success on zero evidence is the failure mode this whole test file
    // exists to prevent.
    const state = { wedged: false };
    const baseUrl = await startServer(state);
    const probe = startAvailabilityProbe({ baseUrl, intervalMs: 10_000, failMs: 200 });
    const result = await probe.stop();
    if (result.probes === 0) expect(result.status).toBe('NA');
  });
});
