## Error handling

### HTTP status decision table

| Status | Code | Action |
|---|---|---|
| `400` | `invalid_request` | Fix the request body or query params |
| `401` | `unauthorized` | Re-fetch token; check `MMAGENT_AUTH_TOKEN` |
| `403` | `forbidden` | `cwd` query param missing or out of scope |
| `404` | `not_found` | Wrong `batchId` or resource does not exist |
| `409` | `invalid_batch_state` / `pinned` | Batch in wrong state; check current state first |
| `413` | `payload_too_large` | Reduce content size (context block or body) |
| `429` | `rate_limited` | Wait `Retry-After` seconds, then retry |
| `503` | `project_cap_exceeded` | Too many concurrent projects; wait and retry |
| `5xx` | server error | Retry once after 2 s; escalate if it persists |

### Network failures

Retry up to 3 times with exponential backoff (1 s → 2 s → 4 s).
If the server is unreachable, check that `mmagent serve` is running:
```bash
curl -s http://localhost:$PORT/health   # expects { ok: true }
```

### Auth errors (401)

```bash
export MMAGENT_AUTH_TOKEN=$(mmagent print-token)
```

The token changes on every server restart. Re-export before retrying.
