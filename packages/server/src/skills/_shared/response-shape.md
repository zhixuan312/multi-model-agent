## Response shapes

### POST /<tool>?cwd=<abs> — dispatch response (202)

```json
{ "batchId": "<uuid>", "statusUrl": "/batch/<uuid>" }
```

Use `batchId` to poll. `statusUrl` is a convenience pointer.

### GET /batch/:id — polling response

The HTTP status is the state discriminator:

| Status | Meaning |
|---|---|
| `202 text/plain` | Still pending — body is the running headline string (e.g. `"1/2 running, 47s elapsed"`) |
| `200 application/json` | Terminal — body is the uniform 7-field envelope below |
| `404` / `401` / `5xx` | Error — see Error response below; stop polling |

The terminal JSON envelope always has these 7 fields. Each may be a real value or a `not_applicable` sentinel:

```json
{
  "headline": "<string>",
  "results": [ /* per-task result objects */ ],
  "batchTimings": { /* timings */ },
  "costSummary": { /* cost roll-up */ },
  "structuredReport": { /* parsed sections */ },
  "error": { "kind": "not_applicable", "reason": "batch succeeded" },
  "proposedInterpretation": { "kind": "not_applicable", "reason": "batch not awaiting clarification" }
}
```

Read the envelope by the shape of `error` and `proposedInterpretation`:

| Shape | Meaning |
|---|---|
| `error` is a real object (with `code` / `message`) | Batch failed — read `error.code` + `error.message` |
| `proposedInterpretation` is a string | Batch is awaiting clarification — invoke `mma-clarifications` |
| Both are `{kind: "not_applicable", ...}` sentinels | Batch succeeded — read `results` |

### GET /batch/:id?taskIndex=N — single task slice

Same 7-field envelope. `results` contains exactly the task at index `N`. Returns `404 unknown_task_index` if `N` is out of range.

### Error response (4xx / 5xx)

```json
{
  "error": "<code>",
  "message": "<human-readable>",
  "details": { /* optional structured context, e.g. fieldErrors for 400 */ }
}
```

`details` is optional and present only when the server has structured additional context.
