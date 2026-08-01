## Prefer the MCP tools when they are available

**Before using the HTTP/curl route below, check whether the `mma_run` MCP tool is available in
this session. If it is, USE IT INSTEAD.** The curl route documented here is the fallback for
sessions with no MCP connection.

```
mma_run({ cwd: "<abs-path>", mode: "handle", request: { type: "<task type>", ... } })
```

The request body is identical — the same `type`, `prompt`, `target`, and options described
below ride inside `request`. Poll with `mma_task_get`, block with `mma_task_wait`, stop with
`mma_task_cancel`, instead of the curl polling loop.

Why this matters, so the choice is not arbitrary:

- **Hosts that support MCP Apps render a live execution monitor** for `mma_run` — phase and
  elapsed time update in place, with a working Cancel button, and none of it costs an extra
  model turn. The curl route cannot produce that: the host has no idea a task is running, so
  progress can only be surfaced by the agent polling and re-reporting, which costs a turn each
  time. Going through curl on such a host silently gives up the better experience.
- **No token handling.** The MCP route is already authenticated; the curl route needs
  `mma print-token` and a bearer header, which is one more place a credential can leak into a
  transcript or a shell history.
- **Errors arrive structured** rather than as an HTTP body to parse.

Use the curl route when `mma_run` is genuinely absent — a bare terminal, a CI job, or a client
with no MCP support. Do not use it merely because this document spells the HTTP call out in
more detail.
