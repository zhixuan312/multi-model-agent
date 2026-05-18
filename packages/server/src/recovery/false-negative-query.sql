-- Recovery candidate-row query with keyset pagination.
-- Returns rows that MAY be false negatives (need re-derivation to confirm).
-- Filters: terminal=error + review_* error_codes + within time window + never recovered.
-- Keyset pagination on id avoids skipping rows when apply mode removes candidates.
SELECT
  id,
  event,
  terminal_status AS original_terminal_status,
  worker_status AS original_worker_status,
  error_code AS original_error_code
FROM mma_telemetry
WHERE terminal_status = 'error'
  AND error_code IN ('review_quality_findings_unresolved', 'review_spec_rejected_terminal')
  AND received_at >= $1
  AND recovered_at IS NULL
  AND id > $3
ORDER BY id
LIMIT $2;
