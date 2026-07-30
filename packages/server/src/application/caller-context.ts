// CallerContext — the transport-independent identity of whoever submitted an
// execution. Adapters construct it at their boundary (REST from the
// X-MMA-Client / X-MMA-Main-Model headers + validated cwd; future adapters
// from their own configuration) and pass it into ExecutionRuntime.submit().
// The runtime must never reach back into a transport request object.

export interface CallerContext {
  /** Calling client name (e.g. 'claude-code', 'cursor'). Recorded verbatim in
   *  wire telemetry's `client` column. */
  clientName: string;
  /** Calling agent's model id (from X-MMA-Main-Model on REST). Used to compute
   *  main-model-equivalent cost. null only when the transport did not require
   *  the header (the REST pipeline rejects tool routes without it). */
  mainModel: string | null;
  /** Canonical project root the execution runs against (the validated cwd). */
  projectRoot: string;
}
