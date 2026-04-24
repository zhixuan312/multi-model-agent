## Response shapes

### POST /<tool>?cwd=<abs> — dispatch response (202)

```json
{
  "batchId": "<uuid>",
  "state": "pending"
}
```

### GET /batch/:id — polling response

```json
{
  "batchId": "<uuid>",
  "state": "pending | running | awaiting_clarification | complete | failed | expired",
  "proposedInterpretation": "<string>",
  "results": [ ... ],
  "headline": "<string>",
  "batchTimings": { ... },
  "costSummary": { ... }
}
```

`proposedInterpretation` is only present when `state` is `awaiting_clarification`.

`results`, `headline`, `batchTimings`, and `costSummary` are only present
when `state` is `complete` or `failed`.

### GET /batch/:id?taskIndex=N — single task slice

Returns the same shape but `results` contains only the task at index `N`.

### Error response (4xx / 5xx)

```json
{
  "error": "<code>",
  "message": "<human-readable>",
  "details": { ... }
}
```

`details` is optional and present only when the server has structured
additional context (e.g. `fieldErrors` for validation failures).
