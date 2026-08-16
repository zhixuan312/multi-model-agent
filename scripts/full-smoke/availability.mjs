import { BASE_URL } from './config.mjs';

/**
 * Availability probe — the instrument the release gate did not have.
 *
 * WHY THIS EXISTS. Every scenario in this harness measures an OUTCOME: did the task reach a
 * terminal status, did the commit land, did the envelope carry the right fields. Not one of them
 * measured whether the daemon stayed ANSWERABLE while doing the work. Those are different
 * properties, and the difference is not academic — it is the exact shape of a defect a user
 * reported after the gate had been green for weeks:
 *
 *   "The daemon has wedged four times today, always HTTP-layer while workers keep running."
 *
 * That defect is INVISIBLE to an outcome-only gate, and the reason is worth stating plainly.
 * Workers are separate processes, so they keep running through a stall in the daemon. Tasks
 * therefore still reach terminal, every scenario still passes, and the harness reports all-green
 * through a daemon that was unreachable for ten seconds at a time. The root cause turned out to
 * be synchronous SQLite work on the daemon's event loop; a caller polling `/health` would have
 * seen it immediately, and nothing in this harness was polling.
 *
 * WHAT IT MEASURES. One `GET /health` every `intervalMs`, from the first scenario to the last.
 * It records the slowest response and the longest CONTINUOUS window in which the daemon did not
 * answer. The continuous window is the number that matters: a caller does not care that the
 * average was fine, it cares that its request sat unanswered for eight seconds.
 *
 * WHAT IT DOES NOT PROVE. A probe cannot distinguish a blocked event loop from a slow one, and it
 * cannot see a stall shorter than its own interval. It is a smoke detector, not a profiler.
 */

/** Above this, the daemon was unreachable long enough that a real caller would have failed. */
const UNAVAILABLE_FAIL_MS = 5_000;
/** Above this, something is stalling the loop even though callers probably survived it. */
const UNAVAILABLE_WARN_MS = 1_500;

export function startAvailabilityProbe({ token, intervalMs = 500, baseUrl = BASE_URL, failMs = UNAVAILABLE_FAIL_MS } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let stopped = false;
  let probes = 0;
  let failures = 0;
  let slowestMs = 0;
  let longestOutageMs = 0;
  let outageStartedAt = null;
  const outages = [];

  // An interruptible sleep. A plain `setTimeout` promise makes `stop()` wait out the remaining
  // interval before it can resolve, so a long interval would delay the end of the run by that
  // interval. The probe must be able to stand down immediately.
  let wake = () => {};
  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  });

  const loop = (async () => {
    while (!stopped) {
      const started = Date.now();
      let ok = false;
      try {
        // The probe carries its own deadline. Without one a wedged daemon would simply never
        // resolve, and the probe would stop sampling exactly when the fault is happening — it
        // would fall silent instead of reporting, which is the failure mode this guards against.
        const res = await fetch(`${baseUrl}/health`, {
          headers,
          signal: AbortSignal.timeout(failMs),
        });
        ok = res.ok;
      } catch {
        ok = false;
      }
      const elapsed = Date.now() - started;
      probes += 1;
      if (elapsed > slowestMs) slowestMs = elapsed;

      if (ok) {
        if (outageStartedAt !== null) {
          const outage = Date.now() - outageStartedAt;
          outages.push(outage);
          if (outage > longestOutageMs) longestOutageMs = outage;
          outageStartedAt = null;
        }
      } else {
        failures += 1;
        if (outageStartedAt === null) outageStartedAt = started;
      }
      if (!stopped) await sleep(intervalMs);
    }
    // A run that ends mid-outage still has to report it, or the worst window in the run — the one
    // that was still open at the end — would be silently dropped.
    if (outageStartedAt !== null) {
      const outage = Date.now() - outageStartedAt;
      outages.push(outage);
      if (outage > longestOutageMs) longestOutageMs = outage;
    }
  })();

  return {
    async stop() {
      stopped = true;
      wake();
      await loop;
      // No `probes === 0 ? 'NA'` arm. The loop's first iteration runs synchronously up to its
      // `await fetch`, before `startAvailabilityProbe` returns, and `probes` is incremented once
      // that settles regardless of `stopped` — so a probe that was started has always sampled at
      // least once by the time `stop()` can observe it. The arm was unreachable, and the test
      // that covered it wrapped its whole assertion in `if (result.probes === 0)`, which never
      // held: a case for "never reports success on zero evidence" that asserted nothing.
      const status = longestOutageMs >= failMs ? 'FAIL'
        : (longestOutageMs >= Math.min(UNAVAILABLE_WARN_MS, failMs / 2) || slowestMs >= Math.min(UNAVAILABLE_WARN_MS, failMs / 2)) ? 'WARN'
          : 'PASS';
      return {
        status,
        probes,
        failures,
        slowestMs,
        longestOutageMs,
        outages,
        detail: `${probes} probes, ${failures} unanswered, slowest ${slowestMs}ms, longest outage ${longestOutageMs}ms`
            + (status === 'FAIL'
              ? ` — the daemon was unreachable for ${longestOutageMs}ms while workers kept running.`
                + ' That is the HTTP-wedge shape: check for synchronous work on the daemon event loop.'
              : ''),
      };
    },
  };
}
