## Budget defaults

| Constant | Value | Notes |
|---|---|---|
| Task timeout | 1 h (3,600,000 ms) | Wall-clock cap per task |
| Stall timeout | 20 min (1,200,000 ms) | Idle gap before force-abort |
| Max cost | $10 USD | Per-task cost cap |
| Cost pre-stop ratio | 0.80 | Pre-stop threshold; see cushion semantics below |
| Time pre-stop ratio | 0.80 | Same pre-stop for timeouts |

**Cushion semantics:** `MAX_COST_PRESTOP_RATIO` and `MAX_TIME_PRESTOP_RATIO` are *pre-stop thresholds*, not overshoot allowances. The runtime warns and may refuse new turns when cost reaches `DEFAULT_MAX_COST_USD × MAX_COST_PRESTOP_RATIO` ($8), but allows an already-in-flight turn to complete. The worst-case total is therefore `DEFAULT_MAX_COST_USD / MAX_COST_PRESTOP_RATIO` ($12.50). Same logic applies to time: worst-case = `DEFAULT_TASK_TIMEOUT_MS / MAX_TIME_PRESTOP_RATIO` (1.25 h).

Callers can override `maxCostUSD` per task. Timeouts are config-wide defaults set in the server config file.
