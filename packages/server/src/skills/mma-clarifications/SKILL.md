---
name: mma-clarifications
description: Confirm or correct the service's proposed interpretation when a batch is awaiting clarification before it can proceed.
when_to_use: When polling GET /batch/:id returns state 'awaiting_clarification'. Read proposedInterpretation, then call this skill to confirm or correct it.
---

## mma-clarifications

When a batch pauses with `state: 'awaiting_clarification'`, the service has
proposed an interpretation of the task and is waiting for your decision.
Read the proposal, then call `POST /clarifications/confirm` to either accept
or correct it. The batch resumes immediately after confirmation.

### Endpoint

`POST /clarifications/confirm`

Auth required. Not cwd-gated (operates on a `batchId`).

@include _shared/auth.md

### Request body

```json
{
  "batchId": "550e8400-e29b-41d4-a716-446655440000",
  "interpretation": "Refactor only the auth module, leaving the user module unchanged"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `batchId` | string (UUID) | yes | Batch in `awaiting_clarification` state |
| `interpretation` | string | yes | Accept proposal verbatim or provide a corrected version |

### Response (200)

```json
{ "batchId": "...", "state": "pending" }
```

`state` is usually `pending` (batch resumes). It may be `complete` if the
executor was already waiting and finishes immediately.

### Full flow

```bash
# 1. Poll until awaiting_clarification
STATE=$(curl -sf -H "Authorization: Bearer $TOKEN" \
  "http://localhost:$PORT/batch/$BATCH_ID" | jq -r '.state')

# 2. Read the proposal
PROPOSAL=$(curl -sf -H "Authorization: Bearer $TOKEN" \
  "http://localhost:$PORT/batch/$BATCH_ID" | jq -r '.proposedInterpretation')

# 3. Confirm (accept proposal or supply corrected text)
curl -sf -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"batchId\":\"$BATCH_ID\",\"interpretation\":\"$PROPOSAL\"}" \
  "http://localhost:$PORT/clarifications/confirm"

# 4. Resume polling
```

@include _shared/polling.md

@include _shared/error-handling.md
