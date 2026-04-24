## Polling for batch completion

After a tool call returns a `batchId`, poll `GET /batch/:id` until the batch
reaches a terminal state.

### Terminal states

| State | Meaning |
|---|---|
| `complete` | All tasks finished — read results |
| `failed` | Batch failed — read error details |
| `expired` | Batch TTL exceeded — retry if needed |

### Awaiting clarification

If `GET /batch/:id` returns `state: 'awaiting_clarification'`, the service
needs your confirmation before it can continue. Read `proposedInterpretation`
from the response, then call `POST /clarifications/confirm` with your chosen
`interpretation` (accept or correct the proposal).

### Poll loop (shell)

```bash
DELAY=1
while true; do
  RESP=$(curl -sf -H "Authorization: Bearer $TOKEN" \
    "http://localhost:$PORT/batch/$BATCH_ID")
  STATE=$(echo "$RESP" | jq -r '.state')
  case "$STATE" in
    complete|failed|expired) echo "$RESP"; break ;;
    awaiting_clarification)
      # Invoke mma-clarifications to confirm interpretation, then continue
      break ;;
    *) sleep $DELAY; DELAY=$(( DELAY < 5 ? DELAY * 2 : 5 )) ;;
  esac
done
```

Start at 1 s, double each iteration, cap at 5 s. Most batches complete in
under 60 s; long tasks may take several minutes.
