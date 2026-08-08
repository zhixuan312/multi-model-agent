// CallerContext — the transport-independent identity of whoever submitted an
// execution. Adapters construct it at their boundary (REST from the
// X-MMA-Client header + validated cwd; future adapters from their own
// configuration) and pass it into ExecutionRuntime.submit(). The runtime must
// never reach back into a transport request object.
//
// No `mainModel`: the cost baseline is the configured `agents.main` tier.

export interface CallerContext {
  /** Calling client name (e.g. 'claude-code', 'cursor'). Recorded verbatim in
   *  wire telemetry's `client` column. */
  clientName: string;
  /** Canonical project root the execution runs against (the validated cwd). */
  projectRoot: string;
}
