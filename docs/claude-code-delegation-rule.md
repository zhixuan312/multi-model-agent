# Multi-Model Agent Delegation Rule for Claude Code

Drop-in rule that teaches Claude Code **when** to delegate work to `multi-model-agent` instead of burning context in its own session. Pairs especially well with the [Superpowers](https://github.com/obra/superpowers) skill set, but works on its own too.

## What this rule gives you

- **Context savings.** Your parent Claude Code session inherits an expensive model by default. This rule redirects mechanical work through `delegate_tasks` — each delegated task runs on a clean, cheap worker context — so your parent session's window stays lean.
- **Cost routing.** Labor goes to free / cheap providers. Reasoning-tier work escalates to expensive providers only when the task genuinely needs it.
- **Concurrency.** Independent tasks dispatched in one `delegate_tasks` call run in parallel.
- **A clear mental model** — *parent = judgment, delegated workers = labor* — so Claude Code stops over-delegating trivial reads and under-delegating big chunks of work.

## Prerequisites

1. `multi-model-agent` MCP registered at **user scope** — see the main [README](../README.md#4-register-the-mcp-server).
2. A `~/.multi-model/config.json` with at least two providers at different cost tiers. The routing guidance below assumes example provider names `minimax` (free) and `codex` (reasoning), with an optional mid-tier `sonnet`. **Substitute your own provider names** wherever you see these.
3. (Optional but strongly recommended) [Superpowers](https://github.com/obra/superpowers) installed — several parts of the rule reference its skills by name. The rule still applies if you don't use Superpowers; just treat those references as "whenever you would normally dispatch a subagent."

## Installation

Pick one:

```bash
# Option A — global (applies in every project)
mkdir -p ~/.claude/rules
curl -o ~/.claude/rules/multi-model-delegation.md \
  https://raw.githubusercontent.com/zhixuan312/multi-model-agent/HEAD/docs/claude-code-delegation-rule.md

# Option B — per project
mkdir -p .claude/rules
curl -o .claude/rules/multi-model-delegation.md \
  https://raw.githubusercontent.com/zhixuan312/multi-model-agent/HEAD/docs/claude-code-delegation-rule.md
```

Or open this file on GitHub, copy the rule body below (from `## Rule Body` onwards), and paste it into your own `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`.

Restart Claude Code after installing so it picks up the new rule file.

---

## Rule Body

Everything below this line is the rule content Claude Code will read. Copy from here down if you're pasting into an existing instruction file. Replace the example provider names (`minimax`, `codex`, optional `sonnet`) with the names from your own `~/.multi-model/config.json`.

### The Principle

The parent Claude Code session runs on whatever model you've selected — typically the most capable and most expensive in your stack. **The parent's job is judgment, not labor.** Judgment is what you're paying the expensive model for; labor is what the cheaper delegated providers are for.

Everything in this rule derives from that single principle. When in doubt, ask: *is this decision-making, or is it mechanical execution of an already-made decision?*

### Judgment vs Labor

**Judgment** — output is a decision, an opinion, or taste-laden creative work. No single correct answer. A senior engineer would want to review a junior's attempt before accepting it. Examples:

- Writing or revising implementation plans
- Brainstorming with the user
- Choosing between approaches
- Deciding what to test
- Reviewing a delegated worker's output and accepting / rejecting it
- Synthesizing across multiple delegated results
- Conversational responses to the user

**Labor** — output is verifiable against a clear spec, mechanical once the decision is made. A skilled-but-junior engineer could complete it unsupervised. Examples:

- Reading files and reporting their contents
- Implementing a fully-specified change
- Searching the codebase for usages or patterns
- Producing a diff that matches a pre-decided design
- Fetching docs or API references from the web
- Mechanical comparison of "does this diff match the plan"

**Borderline test:** imagine handing the task to a skilled-but-junior engineer. Would they ask *"how should I approach this?"* before starting? If yes, the unanswered piece is judgment — the parent must finish that piece before delegating the rest.

**Composition rule — judgment-first, then delegate fully-specified labor.** Real tasks mix judgment and labor. The parent finishes its judgment work first, produces a **zero-decision brief** (a prompt the worker can execute without making any design or scope calls), and *then* dispatches. **Never delegate "figure out how to fix this and implement it."** Only delegate "implement this exact change." If the worker has to make a decision, the judgment leaked out of the parent — claw it back and re-dispatch with a tighter brief.

### Decision Procedure

Walk this in order for every task:

1. **Conversational mode?** Is the user expecting a discussion, an answer, or a quick fix they're watching happen?
   - **In dialogue with the user** → parent inline, don't delegate. Jarring the user mid-conversation costs more than a few expensive-model tokens.
   - **Inside an autonomous workflow** (e.g. `superpowers:executing-plans`, `superpowers:subagent-driven-development`) → continue.
   - **In doubt** → err inline.

2. **Judgment or labor?** Apply the borderline test.
   - **Pure judgment** → parent inline.
   - **Pure labor** → continue.
   - **Mixed** → parent does the judgment first, produces the zero-decision brief, then continues with the labor portion only.

3. **Exception applies?** See *Named Exceptions* below.
   - Shell, planning, trivial-inline, native-only → handle per exception.
   - Otherwise → continue.

4. **Route the labor.**
   - Default → cheapest qualifying provider (typically `minimax`, standard tier).
   - Web research / docs lookup → a provider with `web_search` (typically `codex`). This is intentionally cheaper than the parent's own `WebSearch` tool because the results land in worker context, not yours.
   - Reasoning-tier review (final whole-branch, security-sensitive, architecture) → reasoning-tier provider (typically `codex`) with `effort: "medium"` or `"high"`.
   - Same task already failed on the cheap tier → escalate, don't retry identically.

5. **Dispatch via `mcp__multi-model-agent__delegate_tasks`** using the dispatch shape below.

### Named Exceptions

**Shell stays in the parent — by default.** `shell` is a capability the MCP *can* expose (set `sandboxPolicy: "none"` on a provider or task), but most users leave it off because delegated workers run outside the parent session's Bash and their output is harder to inspect. Keep `pnpm`, `pytest`, `tsc`, `git`, lint, and build commands in the parent via `Bash` unless you have a specific reason to delegate them.

> **TDD pattern with delegated editing:** parent dispatches the *edit*, parent runs the *test* via `Bash`, parent feeds test output into a follow-up dispatch if fixes are needed. This is how you get cheap editing without giving up visible test output.

**Planning, drafting, and ideation stay in the parent.** This is the most important exception — *strategy stays with the strategist*. Always parent-inline:

- Brainstorming with the user
- Writing implementation plans and specs
- Choosing between design approaches
- Requirements gathering
- Synthesizing across delegated results
- Deciding accept / reject on worker output
- Conversational ideation

Research that *informs* a plan can still be delegated (e.g. *"look up the Fastify 5 plugin API and summarize the lifecycle hooks"*). The act of *turning research into a plan* is parent work.

**Trivial-inline carve-out.** Handle inline only when **all four** are true:

1. You already know exactly what to do — no exploration, no reasoning.
2. It's one tool call, maybe two.
3. The result is immediately usable without further synthesis.
4. The prompt you'd write to delegate would be longer than the result.

If any of the four is false, delegate.

**Native `Agent` tool only for things the MCP genuinely can't do.**

- `subagent_type: "Explore"` — *avoid by default*. The MCP can do multi-file exploration on a free provider at zero cost. Use native `Explore` only when exploration genuinely needs the parent session's accumulated grep priors.
- `subagent_type: "Plan"` — architecture planning that has to integrate back into the running session.
- `subagent_type: "claude-code-guide"`, `statusline-setup` — specialized helpers with no MCP equivalent.
- `subagent_type: "general-purpose"` → **never**. If the work is delegable, use the MCP. If it isn't delegable, it shouldn't be in a subagent at all.

### Reading Code (Context-Gathering)

Hybrid pattern: **delegate the survey, read the load-bearing bits inline.** When the parent needs to understand a piece of code to make a judgment call, don't pull whole files into the expensive parent context. Instead:

1. Dispatch a survey task to the free provider: *"Read these files, summarize the data flow, flag any suspicious or surprising bits."* The reading happens in worker context — you pay nothing for the bytes.
2. Parent reads only the specific lines / functions the survey flagged, in parent context.
3. Parent forms its judgment from the small surface it actually read.

Don't read whole files in parent context if a cheap survey can locate the load-bearing parts first.

### Provider Routing

**Route by workload shape, not by price.** The free-vs-paid axis is secondary. The primary question is whether the task's shape fits what a lighter model can actually deliver.

**Cheaper providers sweet spot** (e.g. minimax, claude-haiku):
- ≤ 10 structured output sections
- ≤ 50k input-token workload
- Retrieval tasks (grep, glob, list with structured results)
- Short-form judgment ("does this file match pattern X?", "summarize these 5 imports")
- Single-file edits
- Small test stubs
- Focused research sub-questions

**Reasoning providers sweet spot** (e.g. codex, claude-opus):
- ≥ 20 structured output sections
- Ambiguous judgment that resists a clear rubric
- Security-sensitive review
- Whole-branch synthesis
- Unknown-scope exploration
- Cross-cutting refactors

**Enumerable-deliverable workloads with many items + large input**: never dispatch as a single task. Either decompose and parallelize (see "Decompose and parallelize enumerable work" below) or use retrieval/judgment split. Typical examples: multi-file refactors (10+ files), test generation across many functions (25+), multi-PR review (15+ PRs), per-endpoint analysis (10+ endpoints), codebase audits against long checklists.

The MCP's built-in routing is: **capability filter → tier filter → cheapest qualifying provider**. Set `tier: 'reasoning'` and a higher `effort` level on tasks that match the reasoning sweet spot; leave `tier: 'standard'` for tasks in the cheaper sweet spot.

**Capability hints:**

- Most providers expose `file_read`, `file_write`, `grep`, `glob`. Always pass these as `requiredCapabilities` for code work.
- `web_search` / `web_fetch` are provider-specific. Add them to `requiredCapabilities` only when the task truly needs them — they constrain routing.
- `shell` is advertised as a capability only when the provider (or task) has `sandboxPolicy: "none"`. See the shell exception above before adding `"shell"` to `requiredCapabilities`.

**Effort knob:** reasoning-tier providers honor the `effort` field. Use `effort: "high"` for final whole-branch review and architecture work; `effort: "medium"` is the default for normal reasoning-tier dispatches.

### Writing Delegable Briefs

A delegated worker only works if it receives a **zero-decision brief** — a prompt it can execute without making design or scope calls. The same discipline applies whether you're writing a one-off dispatch or authoring plan tasks in `superpowers:writing-plans`.

Every brief should state:

1. **Explicit file paths.** *"Edit `src/foo.ts:42` to add field X"*, not *"update the types"*.
2. **Explicit scope.** *"Single file, no other files change"* / *"multi-file integration, touch A, B, C"*. The worker should never have to discover how far the task reaches.
3. **Explicit capabilities needed.** If the task needs `web_search`, say so. If it needs `shell`, don't delegate (see the exception).
4. **Explicit acceptance criteria.** *"Zod schema validates positive integers; no runtime coercion"*. The worker should know what "done" looks like without guessing.

**Good brief → cheap delegation:**

```
Task 3 (mechanical, single file): In src/config.ts, add a
`timeoutMs` field to the Config Zod schema with a default of 600000
and positive-integer validation. Do not modify any other file.
Do not run tests. Done = the schema compiles and the new field is
present with the correct validator.
```

→ routes cleanly to the free provider at standard tier.

**Vague brief → forced escalation:**

```
Task 3: Make the timeout configurable.
```

→ forces the worker to decide: which file? schema change? new CLI flag? default value? The parent has leaked judgment into the brief, and the routing has to escalate or the result will be wrong.

**The sharper your brief, the cheaper your delegation.**

#### Declaring deliverable coverage

Declare coverage when the deliverable is enumerable. If your brief asks for N discrete outputs, populate `expectedCoverage.requiredMarkers` with the item identifiers or set `minSections` for simpler shapes. The supervision layer will re-prompt the model with specific missing items and classify thin responses as `insufficient_coverage` instead of silently accepting them.

Worked examples across workload shapes:

- **Multi-file refactor**: `requiredMarkers: ["src/auth.ts", "src/user.ts", ..., "src/session.ts"]` — every file path must appear in the output.
- **Test generation**: `requiredMarkers: ["computeTotal", "validateInput", "formatDate", ...]` — every function name must appear.
- **Multi-PR review**: `requiredMarkers: ["#1234", "#1235", "#1236", ...]` — every PR number must appear.
- **Per-endpoint analysis**: `requiredMarkers: ["/api/users", "/api/orders", "/api/refunds", ...]` — every endpoint path must appear.
- **Codebase audit**: `requiredMarkers: ["1.1", "1.2", ..., "10.2"]` — one per checklist item.

Do NOT declare coverage for one-shot tasks — bug fixes, single implementations, prose explanations, conversational responses, creative writing. The field is opt-in and has no meaning for deliverables you can't enumerate ahead of time. Setting a spurious `minSections: 1` is harmless but pointless.

### Dispatch Shape

Every call to `mcp__multi-model-agent__delegate_tasks` must set:

- `prompt` — the zero-decision brief. Include full context; the worker has no prior memory of your session.
- `tier` — `standard` by default; `reasoning` for security / architecture / final review.
- `requiredCapabilities` — `["file_read", "file_write", "grep", "glob"]` for code work. Add `"web_search"` / `"web_fetch"` only when genuinely needed (it forces routing to a provider that has it). Do **not** add `"shell"` unless you have a deliberate reason.
- `provider` — explicit, per the routing table. Omit only if you want the MCP to pick purely by cost.
- `cwd` — absolute working directory. Never omit; never default to `/`. Use the project or worktree root.
- `sandboxPolicy: "cwd-only"` — confine file writes to the working directory. Only relax this if the task legitimately needs to touch sibling repos.
- `effort` — only when dispatching to a reasoning-tier provider.

**Parallelize when safe.** Independent tasks (different files, no shared state) dispatched in one `tasks` array run concurrently. Bundle them. **Never** dispatch two tasks in parallel that could conflict on the same files. Spec reviewer + code-quality reviewer for the *same* task are sequential (the reviewer needs to see the implementer's output); dispatch them in separate calls.

## Decompose and parallelize enumerable work

When the work has the shape "do N independent things," dispatch N tasks in one `delegate_tasks` call instead of one big task. The MCP runs them concurrently via `Promise.all`. Use `expectedCoverage.requiredMarkers` per task to pin what "done" looks like per-deliverable, and `batchId` + `retry_tasks` to re-dispatch any individual task that came back thin.

**Pattern A: Decompose and parallelize**

Worked examples (ordered cheapest-to-most-complex):

1. **Multi-file refactor**: "Update import syntax in these 10 files" → 10 tasks, one per file. Each task has a minimal `requiredMarkers: ["<the file's primary export>"]` to catch a worker that silently skipped a file. Parent synthesizes if needed (usually unnecessary — per-file diffs are independent).

2. **Test generation across many functions**: "Write unit tests for these 25 functions" → 5 tasks batched 5 functions each. `requiredMarkers: ["<function1>", "<function2>", ...]` per task. Parent collects test files.

3. **Multi-PR review**: "Review these 15 PRs and flag anything concerning" → 15 tasks in parallel (or batched to your provider's rate limit). `requiredMarkers: ["<PR number>"]` per task. Parent synthesizes top-3 concerns across all PRs.

4. **Per-endpoint analysis**: "Analyze these 10 API endpoints for X" → 10 tasks. `requiredMarkers: ["<endpoint path>"]` per task. Parent builds the cross-endpoint report.

5. **Codebase audit** (internal testing ground example): 3 apps × 10 categories = 30 tasks. Each task audits one category for one app.

Parallel dispatch saves wall-clock time — check `timings.estimatedParallelSavingsMs` in the response to see how much.

**Pattern B: Retrieval / judgment split**

When one part of the work is cheap retrieval (grep / list / map) and another part is expensive judgment (synthesize / review / decide), split them across providers. Phase 1: cheap provider does retrieval, emits structured evidence. Phase 2: `register_context_block` the evidence bundle, dispatch judgment to a reasoning provider. The judgment phase never has to re-traverse the source material — it reads the pre-built evidence bundle, dropping input tokens by ~70%.

Example:

- Phase 1 (parallel, minimax): "grep -rn for pattern X, Y, Z in these repos; return structured lists of file:line hits" → 15-20 cheap tasks, each producing a small structured output
- Phase 2 (codex): `register_context_block({ id: "evidence-bundle", content: <concatenated retrieval results> })` → one judgment task that takes `contextBlockIds: ["evidence-bundle"]` and produces the final review

This works for code review ("cheap finds changed files, expensive reviews them"), architecture analysis ("cheap maps module structure, expensive reasons about coupling"), large-scale refactor planning ("cheap enumerates call sites, expensive decides migration strategy"), and many other multi-phase workloads.

## Measuring savings

The MCP exposes four visibility surfaces so callers can see the UX value of delegation without computing anything themselves. All of them are **estimates** for budgeting and debugging, not accounting numbers — actual parent-model cost would vary with context, tool overhead, and retry patterns; actual serial execution would have different cache and warmup characteristics.

**Per-task cost savings**:

- `result.usage.costUSD` — what this task actually cost on the provider that ran it.
- `result.usage.savedCostUSD` — estimated difference vs running the same token volume on your parent-session model. Only populated when you set `parentModel` on the task spec. Set it. It's the number that tells the user "you just saved $0.12 by delegating this instead of letting opus handle it."

**Batch-level aggregates** (always present on the response envelope):

- `aggregateCost.totalActualCostUSD` — sum of per-task costUSD across the batch
- `aggregateCost.totalSavedCostUSD` — sum of per-task savedCostUSD (requires `parentModel` on at least one task)
- `timings.wallClockMs` — how long the batch actually took
- `timings.sumOfTaskMs` — sum of individual task durations (what serial execution would have taken)
- `timings.estimatedParallelSavingsMs` — wall-clock time parallel dispatch bought back vs a hypothetical serial for-loop
- `batchProgress.completedTasks` / `incompleteTasks` / `failedTasks` — static counts at response time
- `batchProgress.successPercent` — clean-success rate (the batch is always 100% DONE by the time you see the response; this field measures how many finished cleanly, NOT progress)

**Example summary a calling agent can compose directly from one `delegate_tasks` response**:

> Dispatched 5 tasks in parallel. Total cost **$0.031** (estimated savings vs opus: **~$0.42**). Wall-clock: **42s** (estimated serial time saved: **~3m 16s**). **4 of 5 tasks completed successfully**, 1 failed with `api_error` — retry via `retry_tasks({ batchId, taskIndices: [3] })` once the provider is available.

Every number in that summary comes from the response envelope fields without caller-side arithmetic. The `retry_tasks` hint comes from inspecting `results[3].status` and `results[3].error`.

## Tightening budgets for weaker models

If a provider returns degraded output on long dispatches, lower its `inputTokenSoftLimit` in your `~/.multi-model/config.json`:

```json
{
  "providers": {
    "minimax": {
      "type": "openai-compatible",
      "model": "MiniMax-M2",
      "inputTokenSoftLimit": 100000
    }
  }
}
```

Counter-intuitive but small models often produce better final answers under tighter budgets because they're forced to commit earlier. The watchdog will fire `force_salvage` at 95k instead of 190k; worst case is a half-read but bounded, instead of an exhausted exploration. Pair with task-level `maxTurns: 40` (instead of the default 200) when dispatching to weaker providers.

### Verification of Delegated Output

When a worker returns `status: "ok"`, apply tiered verification:

- **Mechanical task + small diff (≤30 lines) + tests pass** → trust, don't re-read the diff.
- **Larger diff, or judgment-flavored task** → parent reads the diff inline.
- **Security-sensitive code** (auth, payments, JWT, anything in the trust boundary) → parent reads inline **and** dispatches a separate reasoning-tier review pass.
- **Worker said *"I had to make a decision about X"*** → parent reads inline. The worker has confessed that judgment leaked — claw it back.
- **Tests failed** → parent reads the diff to debug.

Tests passing is **necessary but not sufficient** for trust. Don't outsource *"is this the right code"* to the test suite.

### Sandbox Enforcement

When you dispatch with `sandboxPolicy: "cwd-only"` (the recommended default), the MCP applies the following rules inside every delegated task. These are enforced per-call in the core `assertWithinCwd` helper — the model can see the rejection message and retry with a corrected path.

1. **File reads** are confined to `cwd` and its descendants. Paths outside (absolute paths elsewhere, `../` traversal) are rejected with an error surfaced to the model.
2. **File writes** are subject to the same restriction.
3. **Symlink resolution uses `fs.realpath`.** A symlink inside `cwd` that points outside `cwd` is treated as outside and rejected — the check runs on the resolved real path, not the literal path the model passed.
4. **Nonexistent target paths** resolve by walking back to the nearest existing ancestor and reapplying the same check, so symlinks in ancestor directories are still caught.
5. **`runShell` is hard-disabled** under `cwd-only`. Calling it returns an error telling the model to use `readFile` / `writeFile` / `grep` / `glob` / `listFiles` instead. Only tasks (or providers) with `sandboxPolicy: "none"` get shell access at all.
6. **The check is per-call**, not per-session. Every tool invocation re-validates — there is no "trusted" state the model can earn inside a run.
7. **Errors are surfaced to the model** as normal tool errors, not silently swallowed. The model observes the rejection in its tool result and can adjust (e.g. re-root a path, ask for the right `cwd`).

The default is `cwd-only`. Only set `sandboxPolicy: "none"` per-provider or per-task when you intentionally want shell access or cross-repo file writes — and remember that `shell` only appears in a provider's capability set when its effective sandbox policy is `"none"`, so auto-routing will not accidentally route shell work into a sandboxed worker.

### Status Handling

`delegate_tasks` returns one object per task with fields `provider`, `status`, `output`, `turns`, `filesRead`, `filesWritten`, `toolCalls`, `escalationLog`, `usage`, and optionally `error`. The `status` field is one of exactly eight protocol values:

| `status` | Meaning | What caller should do | How it happens |
|---|---|---|---|
| `ok` | Worker finished normally with usable output | Read `output`. Apply tiered verification. Check for any "blocked" / "needs context" markers the worker may have put in its text. | Runner's agent loop returned a non-empty final message that passed the supervision completeness check. |
| `incomplete` | Agent loop terminated but the runner had to salvage partial work from the scratchpad instead of accepting a final message | Read `output` — it contains the best text the scratchpad captured plus a diagnostic line (turn count, input tokens, which files were read). Re-dispatch with a tighter brief or escalate provider tier — do **not** retry the same provider with the same prompt. | Runner hit a degenerate completion (empty / thinking-only / fragment) and exhausted its supervision retries, **or** the input-token watchdog forced salvage at its 95% threshold. |

> Note (v0.3+): `incomplete` is also produced when a caller declared `expectedCoverage` and the model's output didn't meet the coverage contract after 3 supervision re-prompts. The specific missing items are captured in `escalationLog[i].reason`. Fix by either splitting the task (see "Decompose and parallelize enumerable work"), escalating to a reasoning provider, or revisiting whether the coverage declaration is reasonable.
| `max_turns` | Hit `maxTurns` before completing | Worker looped. Re-dispatch on a higher-tier provider with a tighter brief, or break the task down. The scratchpad is still salvaged into `output`. | The agent loop ran `maxTurns` iterations without emitting a final answer. |
| `timeout` | Hit `timeoutMs` before completing | Task is too large or the worker is stuck. Break into smaller pieces; don't just raise the timeout. Scratchpad is salvaged into `output`. | The runner's per-attempt deadline fired. |
| `api_aborted` | Provider-side abort — either a signal cancellation or a transport drop that the SDK reported as an abort | Inspect `error`. If transient, escalation has already walked the chain for auto-routed tasks — if none recovered, re-dispatch with a different provider or retry later. | Codex/Claude/OpenAI SDKs raise an abort error (e.g. `"Request was aborted"`, `AbortError`, signal cancellation). |
| `api_error` | HTTP error from the provider (the thrown error had a numeric `.status`) | Read `error` for the status code and provider message. 4xx → fix the request; 5xx → retry/escalate. Scratchpad is still salvaged. | Provider returned a non-2xx HTTP response. |
| `network_error` | Transport-level failure before the request reached the provider | Read `error`. Usually transient — escalation has already tried the chain; if everything failed, retry later. | `code === 'ECONNREFUSED'`, `code === 'ENOTFOUND'`, or a message matching `/network/i`. |
| `error` | Everything else — a runner-side exception that doesn't fit the buckets above | Read `error`. Usually a capability mismatch, missing API key, an unavailable model, or a bug in the runner. Fix the call; don't blindly retry. | Thrown exception with no matching classification (`assertWithinCwd` violations, validation errors, unexpected SDK shapes, etc.). |

**Two layers — don't confuse them.** The eight values above are the *protocol* status. Any `DONE` / `BLOCKED` / `NEEDS_CONTEXT` / `DONE_WITH_CONCERNS` conventions (from Superpowers prompt templates, for example) live *inside* the `output` text, not in `status`. A worker can return `status: "ok"` with `output` text saying *"BLOCKED: I need access to the prod config file."* Read both layers.

**The `escalationLog` field** — an array of `AttemptRecord` entries, one per provider actually attempted within this dispatch. Length is 1 for tasks that succeeded on the first try; longer when auto-routing walked to a fallback. Each entry carries `provider`, `status`, `turns`, `inputTokens`, `outputTokens`, `costUSD`, `initialPromptLengthChars`, `initialPromptHash`, and an optional `reason`. `initialPromptHash` is a sha256 of the **canonical orchestrator-side brief** `${systemPrompt}\n\n${budgetHint}\n\n${prompt}` — it is *not* a wire-level checksum (each SDK wraps this in its own envelope before sending; Claude specifically prepends the `claude_code` preset to the system prompt). Use it to confirm *"the orchestrator sent the same brief on every attempt"*; it is cross-runner stable, so identical briefs produce identical hashes regardless of which runner executed them.

### Escalation Ladder

**Never retry the same provider with the same prompt. Never escalate without changing something.**

**The MCP handles provider-level escalation for you on auto-routed tasks.** When a task omits `provider`, the MCP walks the full escalation chain (capability + tier filter, cheapest-first) automatically on failure — you do not need to re-dispatch manually to get a task routed to the next-cheapest qualifying provider. The chain walk stops at the first `ok`. If every provider fails, the best salvaged result is returned and `escalationLog` shows every attempt. **Explicit pins (`provider:` set on the task) still run as a single attempt** — pinning opts out of the auto-walk, and one failure is the final answer.

**Scratchpad salvage runs on every termination path.** `incomplete`, `max_turns`, `timeout`, `api_aborted`, `api_error`, `network_error`, and `error` all still populate `output` from the best scratchpad content the runner captured. You never get a bare failure with no text — there is always *something* to read, even if it's just the diagnostic line.

**Retry failed tasks via `retry_tasks`.** Every `delegate_tasks` response includes a top-level `batchId`. To re-run a subset, call `retry_tasks` with `{ batchId, taskIndices }` (0-based indices into the original batch) — the original briefs stay server-side, so the parent does not re-transmit them. Batches expire 30 minutes **after creation** (not last access — access does not refresh TTL); under memory pressure they are evicted **LRU** (least-recently-*used*: a hot batch you keep retrying stays alive, cold newer batches get evicted first) with a cap of 100 batches. If the batch is gone, fall back to `delegate_tasks` with full task specs.

**When you still need to escalate by hand** (e.g. you pinned a provider, or the auto-walk exhausted all options):

1. **First failure** → re-dispatch on the *same* provider with an **enriched prompt** (more context, tighter acceptance criteria, explicit file paths).
2. **Second failure** → escalate to the reasoning tier.
3. **Failure on the reasoning tier** → break the task into smaller pieces and restart, or claw back to parent inline.

When the worker's text output reports it's blocked (`status: "ok"` but blocked in the text):

- **Missing context** → enrich the prompt and re-dispatch on the same provider.
- **Reasoning gap** → escalate to the reasoning tier.
- **Capability gap** (worker wants to run tests / shell) → run the command yourself in `Bash`, feed its output into a follow-up dispatch. Do **not** fall back to a Claude-native `general-purpose` subagent for shell.

### Quick Reference

```
Got a task?
│
├─ Is it conversational / user-watching? ──► parent inline
├─ Is it pure judgment (planning, review, taste)? ──► parent inline
├─ Trivial-inline 4-condition test passes? ──► parent inline
├─ Needs shell and sandboxPolicy is not "none"? ──► parent Bash
├─ Is it Explore / Plan / claude-code-guide? ──► native Agent tool
└─ Otherwise — labor with a zero-decision brief
      │
      └─► mcp__multi-model-agent__delegate_tasks
            │
            ├─ File-only mechanical work? ──► free provider, standard
            ├─ Needs web research? ──► web-capable provider, standard
            ├─ Multi-file integration? ──► mid or reasoning, standard
            └─ Architecture / final review / security? ──► reasoning, effort: high
```
