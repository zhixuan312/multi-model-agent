# MCP Apps on Claude Desktop — manual release verification

The automated suite proves everything that can be proven without a host: the resource is served,
the bytes are self-contained, the bundle executes, the App reaches the server only through
`callServerTool`. What it cannot prove is that **Claude Desktop actually renders the App inline**,
because that depends on a host we do not ship and cannot drive from CI.

So this runbook is the release gate for exactly that gap. Run it against a real Claude Desktop
before publishing a build that changes the MCP App surface, and record the outcome in place.

**Record `Fail` if the step is blocked, skipped, or ambiguous.** A step that could not be run is
not a step that passed, and treating the two alike is how a broken App ships with a green gate.

- **Build under test:** `_____________________`  (version / commit)
- **Claude Desktop version:** `_____________________`
- **Date / owner:** `_____________________`

---

1. Install the packaged build, run `mma mcp install`, then **fully quit** Claude Desktop (not just
   close the window) and relaunch it.
   - Observe: the MMA server appears connected in Claude Desktop's MCP settings, with its tools
     listed and no connection error.
   - Pass / Fail: `______`

2. Start a long-running `mma_run` (one that takes at least a minute — an `execute_plan` or
   `investigate` task, not an inline type).
   - Observe: the execution monitor renders **inline in the conversation** as a UI panel, rather
     than the response appearing as a JSON text block.
   - Pass / Fail: `______`

3. Watch the monitor for at least three update cycles (roughly six seconds).
   - Observe: phase and elapsed time advance on their own, with **no additional model turn** — the
     token counter does not move and no new assistant message appears.
   - Pass / Fail: `______`

4. Press **Cancel** while the task is still running.
   - Observe: the button disables immediately and the monitor shows a pending *cancelling* state
     before any terminal state; pressing it again does nothing.
   - Pass / Fail: `______`

5. Wait for the task to reach a terminal state.
   - Observe: final status, cost, and summary render, and polling stops (elapsed time freezes; no
     further updates).
   - Pass / Fail: `______`

6. From **Claude Code CLI**, against the same daemon, run the same tool call.
   - Observe: the CLI response is the identical single complete JSON text block it produced before
     Flow 2 — byte-identical in shape, with no UI resource reference and no truncation. The App is
     additive for App-capable hosts; it must not alter what a non-App client receives.
   - Pass / Fail: `______`

---

## If a step fails

Do not publish. Record which step failed and what was observed, then file it against the MCP Apps
surface — a failure here means either the host contract changed or the packaged artifact is not the
one that was tested.

Notes:

```
```
