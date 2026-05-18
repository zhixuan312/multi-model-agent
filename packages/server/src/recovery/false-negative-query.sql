-- Recovery candidate-row query with keyset pagination.
-- Returns rows that MAY be false negatives (need re-derivation to confirm).
-- Filters: terminal=error + within time window + never recovered.
-- Keyset pagination on id avoids skipping rows when apply mode removes candidates.
--
-- NOTE on scope: the spec originally proposed a narrow error_code IN (review_*)
-- filter for safety. Production data shows the error_code column is NULL on
-- virtually all rows (the 4.7.7 error_code threading didn't reliably populate
-- the wire column in practice). The narrow filter would catch zero rows.
-- The broader filter is safe because deriveCompletionFromWire is the per-row
-- arbiter: rows the adapter judges completed=false (real failures: halted
-- implement, changes_required without rework, etc.) are counted as
-- legitFailures and NOT updated. Only rows the adapter judges completed=true
-- get UPDATE'd. Same per-row guarantee, larger candidate pool.
SELECT
  id,
  event,
  terminal_status AS original_terminal_status,
  worker_status AS original_worker_status,
  error_code AS original_error_code
FROM mma_telemetry.events_raw
WHERE terminal_status = 'error'
  AND received_at >= $1
  AND recovered_at IS NULL
  AND id > $3
ORDER BY id
LIMIT $2;
