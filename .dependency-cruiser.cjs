module.exports = {
  forbidden: [
    {
      name: 'no-substrate-to-unified',
      severity: 'error',
      from: { path: '^packages/core/src/(transport|config|identity|stores|providers|bounded-execution|events)/' },
      to:   { path: '^packages/core/src/unified/' },
    },
    {
      // CLAUDE.md: "http/ — Thin transport adapters (parse → runtime → serialize); depends
      // one-way on application/". The rule was stated in prose and enforced by nothing. It holds
      // today; this keeps it holding. A reverse edge would make the application layer un-runnable
      // without an HTTP request, which is precisely what the MCP adapter and the CLI need it to be.
      name: 'no-application-to-http',
      severity: 'error',
      from: { path: '^packages/server/src/application/' },
      to: { path: '^packages/server/src/http/' },
    },
    // Neither transport surface may reach into the other's HANDLERS. `mcp/` used to import the
    // shared context-block operations from `http/handlers/control/context-blocks.ts` — right in
    // spirit (one implementation, two callers) but it put the shared code on one transport's side
    // of the fence. Those operations now live in `application/context-block-ops.ts`, where both
    // adapters reach them as equals.
    //
    // Scoped to `handlers/`, deliberately, and NOT to `http/` wholesale. Two things a broader rule
    // gets wrong, both found by running it:
    //
    //   - MCP here is served OVER HTTP, at `POST /mcp`. Its requests ARE IncomingMessages, so
    //     `mcp-adapter.ts` importing `http/middleware/caller-identity.js` to parse the same headers
    //     is correct, not a leak.
    //   - `http/server.ts` is the composition root: it MOUNTS the MCP adapter on the listener.
    //     Wiring is not a dependency between peers.
    //
    // Two directed rules rather than one symmetric `(mcp|http) -> (http|mcp)`, which would also
    // match http→http and mcp→mcp and forbid every intra-layer import in both trees.
    {
      name: 'no-mcp-to-http-handlers',
      severity: 'error',
      from: { path: '^packages/server/src/mcp/' },
      to: { path: '^packages/server/src/http/handlers/' },
    },
    {
      name: 'no-http-handlers-to-mcp',
      severity: 'error',
      from: { path: '^packages/server/src/http/handlers/' },
      to: { path: '^packages/server/src/mcp/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // Track type-only imports. Without this, `import type { X } from '…'` is erased before the
    // cruiser sees it, and EVERY rule here is bypassable by writing `import type`. It was: the
    // `no-substrate-to-unified` rule above had a live violation
    // (providers/claude-cwd-confinement.ts → unified/type-registry.ts) that no run ever reported,
    // and elsewhere the same pressure produced an inline duplicate of the union rather than an
    // import. Turning this on took the graph from 364 edges to 532 — 168 the rules could not see.
    // A type-only import still couples two modules in the source; for an architecture rule,
    // coupling is coupling.
    tsPreCompilationDeps: true,
    doNotFollow: {
      path: 'node_modules',
      dependencyTypes: ['npm'],
    },
    includeOnly: '^packages/(core|server)/src/',
  },
};
