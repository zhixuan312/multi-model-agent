## Response shapes

### POST /task?cwd=<abs> — dispatch response (202)

```json
{ "taskId": "<uuid>", "statusUrl": "/task/<uuid>" }
```

Use `taskId` to poll. `statusUrl` is a convenience pointer.

### GET /task/:taskId — polling response

The HTTP status is the state discriminator:

| Status | Meaning |
|---|---|
| `202 text/plain` | Still pending — body is the running headline string (e.g. `"1/2 running, 47s elapsed"`) |
| `200 application/json` | Terminal — body is the layered envelope below |
| `404` / `401` / `5xx` | Error — see Error response below; stop polling |

The terminal JSON envelope always has these 6 top-level fields:

```json
{
  "task":      { "taskId": "<uuid>", "type": "<route>", "status": "completed" },
  "output":    { "summary": { /* refiner JSON */ }, "findings": [...] },
  "execution": { "stages": [...], "stopReason": "normal", "haltedStage": null },
  "metrics":   { "totalDurationMs": 12400, "totalCostUSD": 0.08 },
  "raw":       { /* provider-level detail; not for main-agent consumption */ },
  "error":     null
}
```

Read the envelope by the shape of `error`:

| Shape | Meaning |
|---|---|
| `error` is `null` or absent | Task succeeded — read `output` |
| `error` is a real object (with `code` / `message`) | Task failed — read `error.code` + `error.message` |

### GET /task/:taskId?taskIndex=N — single task slice

Same 6-field envelope scoped to the task at index `N`. Returns `404 unknown_task_index` if `N` is out of range.

### Error response (4xx / 5xx)

```json
{
  "error": "<code>",
  "message": "<human-readable>",
  "details": { /* optional structured context, e.g. fieldErrors for 400 */ }
}
```

`details` is optional and present only when the server has structured additional context.
