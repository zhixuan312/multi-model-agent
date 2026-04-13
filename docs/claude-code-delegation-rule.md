# Multi-Model Agent Delegation Rule for Claude Code

Drop-in rule that teaches Claude Code **when** to delegate work to `multi-model-agent` instead of burning context in its own session. Pairs especially well with the [Superpowers](https://github.com/obra/superpowers) skill set, but works on its own too.

## What this rule gives you

- **Context savings.** Your parent session inherits an expensive model by default. This rule redirects mechanical work through `delegate_tasks` — each delegated task runs on a clean, cheap worker context — so your parent session's window stays lean.
- **Cost routing.** Labor goes to `standard` slot (cheap / fast). Work that genuinely needs reasoning goes to `complex` slot (slower, higher cost, but only when warranted).
- **Concurrency.** Independent tasks dispatched in one `delegate_tasks` call run in parallel.
- **A clear mental model** — *parent = judgment, delegated workers = labor* — so Claude Code stops over-delegating trivial reads and under-delegating big chunks of work.

## Prerequisites

1. `multi-model-agent` MCP registered at **user scope** — see the main [README](../README.md#quick-start).
2. A `~/.multi-model/config.json` with at least two agents at different `agentType` slots. The routing guidance below assumes example agent names `fast` (standard) and `reasoner` (complex). **Substitute your own agent names** wherever you see these.
3. (Optional but strongly recommended) [Superpowers](https://github.com/obra/superpowers) installed — several parts of the rule reference its skills by name. The rule still applies without Superpowers; treat those references as "whenever you would normally dispatch a subagent."

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

Everything below this line is the rule content Claude Code will read. Copy from here down if you're pasting into an existing instruction file. Replace the example agent names (`fast`, `reasoner`) with the names from your own `~/.multi-model/config.json`.

### The Principle

The parent session runs on whatever model you've selected — typically the most capable and most expensive in your stack. **The parent's job is judgment, not labor.** Judgment is what you're paying the expensive model for; labor is what the cheaper delegated agents are for.

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

### The Five-Phase Contract

Every delegated task moves through five phases:

1. **Brief** — parent produces a zero-decision brief
2. **Readiness check** — `normalizeBrief` evaluates the brief and outputs a `ReadinessReport` (`READY` or `NOT_READY` with named gaps). If `NOT_READY`, fix the brief before dispatching
3. **Dispatch** — route to `standard` or `complex` slot based on `agentType`
4. **Execute** — agent works under cost ceiling, call cache, format constraints
5. **Review** (if enabled) — spec/quality review on the *other* slot (not the slot that did the work)

The readiness check is the gate. A `NOT_READY` verdict means the brief is too vague, too ambitious, or missing required context — fix it before spending money.

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

4. **Readiness check passes?** Call `normalizeBrief` (or equivalent readiness evaluator) on your draft brief.
   - **`NOT_READY`** → fix the named gaps before dispatching
   - **`READY`** → continue

5. **Route the labor.**
   - Default → cheapest qualifying `standard` slot (typically `fast`)
   - Web research / docs lookup → a provider with `web_search` (typically `fast` with hosted tools, or `reasoner` if scope is large)
   - Multi-file integration, architecture, security review, whole-branch synthesis → `complex` slot (typically `reasoner`)

### Named Exceptions

**Shell stays in the parent — by default.** `shell` is a capability the MCP *can* expose (set `sandboxPolicy: "none"` on an agent or task), but most users leave it off because delegated workers run outside the parent session's Bash and their output is harder to inspect. Keep `pnpm`, `pytest`, `tsc`, `git`, lint, and build commands in the parent via `Bash` unless you have a specific reason to delegate them.

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

- `subagent_type: "Explore"` — *avoid by default*. The MCP can do multi-file exploration on a `standard` slot at low cost. Use native `Explore` only when exploration genuinely needs the parent session's accumulated grep priors.
- `subagent_type: "Plan"` — architecture planning that has to integrate back into the running session.
- `subagent_type: "claude-code-guide"`, `statusline-setup` — specialized helpers with no MCP equivalent.
- `subagent_type: "general-purpose"` → **never**. If the work is delegable, use the MCP. If it isn't delegable, it shouldn't be in a subagent at all.

### Reading Code (Context-Gathering)

Hybrid pattern: **delegate the survey, read the load-bearing bits inline.** When the parent needs to understand a piece of code to make a judgment call, don't pull whole files into the expensive parent context. Instead:

1. Dispatch a survey task to the `standard` slot: *"Read these files, summarize the data flow, flag any suspicious or surprising bits."* The reading happens in worker context — you pay nothing for the bytes.
2. Parent reads only the specific lines / functions the survey flagged, in parent context.
3. Parent forms its judgment from the small surface it actually read.

Don't read whole files in parent context if a cheap survey can locate the load-bearing parts first.

### AgentType Routing

**Route by workload shape, not by price.** The `standard` vs `complex` axis is about capability fit, not budget preference.

**`standard` slot sweet spot** (e.g. MiniMax-M2, claude-sonnet):
- ≤ 10 structured output sections
- ≤ 50k input-token workload
- Retrieval tasks (grep, glob, list with structured results)
- Short-form judgment ("does this file match pattern X?", "summarize these 5 imports")
- Single-file edits
- Small test stubs
- Focused research sub-questions

**`complex` slot sweet spot** (e.g. codex, claude-opus):
- ≥ 20 structured output sections
- Ambiguous judgment that resists a clear rubric
- Security-sensitive review
- Whole-branch synthesis
- Unknown-scope exploration
- Cross-cutting refactors

**Enumerable-deliverable workloads with many items + large input**: never dispatch as a single task. Either decompose and parallelize (see "Decompose and parallelize enumerable work" below) or use retrieval/judgment split. Typical examples: multi-file refactors (10+ files), test generation across many functions (25+), multi-PR review (15+ PRs), per-endpoint analysis (10+ endpoints), codebase audits against long checklists.

The MCP's routing is: **capability filter → `agentType` filter → cheapest qualifying agent**. Set `agentType: "complex"` for work in the complex sweet spot; leave `agentType: "standard"` for standard sweet spot work.

**Capability hints:**

- Most agents expose `file_read`, `file_write`, `grep`, `glob`. Always pass these as `requiredCapabilities` for code work.
- `web_search` / `web_fetch` are provider-specific. Add them to `requiredCapabilities` only when the task truly needs them — they constrain routing.
- `shell` is advertised as a capability only when the agent (or task) has `sandboxPolicy: "none"`. See the shell exception above before adding `"shell"` to `requiredCapabilities`.

### Using the Specialized Tools

The four specialized tools are purpose-built for specific sub-routines. Use them instead of hand-rolling `delegate_tasks` calls for these shapes:

| Tool | When to use it | What it does |
|---|---|---|
| `audit_document` | Verifying a spec document's requirements are met | Checks each requirement, flags gaps. Accepts file paths — multiple files audited in parallel. |
| `debug_task` | Triage a failure against known failure patterns | Maps symptoms to known patterns, suggests fixes |
| `review_code` | Structural quality review of a diff or module | Checks structure, style, security, test coverage. Accepts file paths — multiple files reviewed in parallel. |
| `verify_work` | Confirm implementation matches spec | Cross-checks against spec requirements. Accepts file paths — multiple files verified in parallel. |

For tasks that don't fit one of these shapes, or that need pipeline customization (reviewPolicy, maxReviewRounds, effort, etc.), use `delegate_tasks` directly.

### Writing Delegable Briefs

A delegated worker only works if it receives a **zero-decision brief** — a prompt it can execute without making design or scope calls. The same discipline applies whether you're writing a one-off dispatch or authoring plan tasks in `superpowers:writing-plans`.

Every brief should state:

1. **Explicit file paths.** *"Edit `src/foo.ts:42` to add field X"*, not *"update the types"*.
2. **Explicit scope.** *"Single file, no other files change"* / *"multi-file integration, touch A, B, C"*. The worker should never have to discover how far the task reaches.
3. **Explicit capabilities needed.** If the task needs `web_search`, say so. If it needs `shell`, don't delegate (see the exception).
4. **Explicit acceptance criteria.** *"Zod schema validates positive integers; no runtime coercion"*. The worker should know what "done" looks like without guessing.

**Brief quality → routing outcome:**

- **Good brief** → `agentType: "standard"` routes cleanly to the cheap slot
- **Vague brief** → forces escalation to `complex` or returns `NOT_READY` from readiness check

**The sharper your brief, the cheaper your delegation.**

#### Examples

**Bad** (vague, forces escalation):

```
Task 3: Make the timeout configurable.
```

→ worker must decide: which file? schema change? new CLI flag? default value? The parent leaked judgment into the brief. Forces `agentType: "complex"` or gets `NOT_READY`.

**Acceptable** (direction is clear, still needs context):

```
Task 3: Add a configurable timeout to the HTTP client.
```

→ routes to `standard` but may need follow-up clarification.

**Ideal** (zero-decision, explicit scope):

```
Task 3 (mechanical, single file): In src/config.ts, add a
`timeoutMs` field to the Config Zod schema with a default of 600000
and positive-integer validation. Do not modify any other file.
Do not run tests. Done = the schema compiles and the new field is
present with the correct validator.
```

→ routes cleanly to `standard` at lowest cost.

#### Declaring deliverable coverage

Declare coverage when the deliverable is enumerable. If your brief asks for N discrete outputs, populate `expectedCoverage.requiredMarkers` with the item identifiers or set `minSections` for simpler shapes. The supervision layer will re-prompt with specific missing items and classify thin responses as `insufficient_coverage` instead of silently accepting them.

Worked examples:

- **Multi-file refactor**: `requiredMarkers: ["src/auth.ts", "src/user.ts", ..., "src/session.ts"]`
- **Test generation**: `requiredMarkers: ["computeTotal", "validateInput", "formatDate", ...]`
- **Multi-PR review**: `requiredMarkers: ["#1234", "#1235", "#1236", ...]`
- **Per-endpoint analysis**: `requiredMarkers: ["/api/users", "/api/orders", "/api/refunds", ...]`
- **Codebase audit**: `requiredMarkers: ["1.1", "1.2", ..., "10.2"]`

Do NOT declare coverage for one-shot tasks — bug fixes, single implementations, prose explanations, conversational responses, creative writing.

### Dispatch Shape

Every call to `mcp__multi-model-agent__delegate_tasks` must set:

- `prompt` — the zero-decision brief. Include full context; the worker has no prior memory of your session.
- `agentType` — `"standard"` by default; `"complex"` for multi-file integration, architecture, security, final review.
- `requiredCapabilities` — `["file_read", "file_write", "grep", "glob"]` for code work. Add `"web_search"` / `"web_fetch"` only when genuinely needed. Do **not** add `"shell"` unless you have a deliberate reason.
- `cwd` — absolute working directory. Never omit; never default to `/`. Use the project or worktree root.
- `sandboxPolicy: "cwd-only"` — confine file writes to the working directory. Only relax this if the task legitimately needs to touch sibling repos.

For `agentType: "complex"` dispatches, you can set `effort: "high"` to signal that the reasoning slot should apply maximum reasoning effort.

**Parallelize when safe.** Independent tasks (different files, no shared state) dispatched in one `tasks` array run concurrently. Bundle them. **Never** dispatch two tasks in parallel that could conflict on the same files. Spec reviewer + code-quality reviewer for the *same* task are sequential (the reviewer needs to see the implementer's output); dispatch them in separate calls.

## Decompose and parallelize enumerable work

When the work has the shape "do N independent things," dispatch N tasks in one `delegate_tasks` call instead of one big task. The MCP runs them concurrently via `Promise.all`. Use `expectedCoverage.requiredMarkers` per task to pin what "done" looks like per-deliverable, and `batchId` + `retry_tasks` to re-dispatch any individual task that came back thin.

**Pattern A: Decompose and parallelize**

Worked examples (ordered cheapest-to-most-complex):

1. **Multi-file refactor**: "Update import syntax in these 10 files" → 10 tasks, one per file. Each task has a minimal `requiredMarkers: ["<the file's primary export>"]` to catch a worker that silently skipped a file.

2. **Test generation across many functions**: "Write unit tests for these 25 functions" → 5 tasks batched 5 functions each. `requiredMarkers: ["<function1>", "<function2>", ...]` per task.

3. **Multi-PR review**: "Review these 15 PRs and flag anything concerning" → 15 tasks in parallel (or batched to your provider's rate limit). `requiredMarkers: ["<PR number>"]` per task.

4. **Per-endpoint analysis**: "Analyze these 10 API endpoints for X" → 10 tasks. `requiredMarkers: ["<endpoint path>"]` per task.

**Pattern B: Retrieval / judgment split**

When one part of the work is cheap retrieval (grep / list / map) and another part is expensive judgment (synthesize / review / decide), split them across slots. Phase 1: `standard` slot does retrieval, emits structured evidence. Phase 2: `register_context_block` the evidence bundle, dispatch judgment to `complex` slot. The judgment phase never has to re-traverse the source material — it reads the pre-built evidence bundle, dropping input tokens by ~70%.

Example:
- Phase 1 (parallel, `standard`): "grep -rn for pattern X, Y, Z in these repos; return structured lists of file:line hits" → 15-20 cheap tasks
- Phase 2 (`complex`): `register_context_block({ id: "evidence-bundle", content: <concatenated retrieval results> })` → one judgment task that takes `contextBlockIds: ["evidence-bundle"]`

## Measuring savings

Every `delegate_tasks` response envelope contains:

- `headline` — pre-computed one-liner: `tasks / success / wall-clock / cost / ROI`. Quote it verbatim to the user without arithmetic.
- `timings.wallClockMs` — actual batch wall-clock
- `timings.sumOfTaskMs` — what serial execution would have taken
- `timings.estimatedParallelSavingsMs` — wall-clock time saved vs serial
- `aggregateCost.totalActualCostUSD` / `totalSavedCostUSD` — batch cost rollup

**If the primary response was truncated** (client-side size limit), call `get_batch_slice(batchId, "telemetry")` to retrieve the headline and envelope fields in a bounded-small response.

## Status Handling

Every task returns one of eight protocol status values:

| `status` | Meaning | Caller action |
|---|---|---|
| `ok` | Worker finished normally | Read `output`. Apply tiered verification. |
| `incomplete` | Worker salvaged partial work | Read `output`. Fix brief or escalate `agentType`. |
| `max_turns` | Hit `maxTurns` before completing | Re-dispatch with tighter brief or escalate to `complex`. |
| `timeout` | Hit `timeoutMs` before completing | Break into smaller pieces; don't just raise the timeout. |
| `api_aborted` | Provider-side abort | Retry with a different agent or later. |
| `api_error` | HTTP error from provider | Read `error`. 4xx → fix request; 5xx → retry/escalate. |
| `network_error` | Transport-level failure | Retry later; escalation already walked the chain. |
| `error` | Runner-side exception | Read `error`. Fix the call; don't blindly retry. |

**Two layers — don't confuse them.** The eight values above are the *protocol* status. Any `DONE` / `BLOCKED` / `NEEDS_CONTEXT` / `DONE_WITH_CONCERNS` conventions (from Superpowers prompt templates, for example) live *inside* the `output` text, not in `status`. A worker can return `status: "ok"` with `output` text saying *"BLOCKED: I need access to the prod config file."* Read both layers.

**Scratchpad salvage runs on every termination path.** `incomplete`, `max_turns`, `timeout`, `api_aborted`, `api_error`, `network_error`, and `error` all populate `output` from the best scratchpad content the runner captured.

**Retry via `retry_tasks`.** Every `delegate_tasks` response includes a `batchId`. To re-run a subset, call `retry_tasks({ batchId, taskIndices })` — original briefs stay server-side. Batches expire 30 minutes after creation with a 100-batch LRU cap.

### Escalation Ladder

**Never retry the same agent with the same prompt. Never escalate without changing something.**

The MCP handles agent-level escalation for you on auto-routed tasks. When a task omits `agent`, the MCP walks the escalation chain automatically. Explicit pins (`agent:` set) run as a single attempt.

**When you still need to escalate by hand** (e.g. you pinned an agent, or the auto-walk exhausted all options):

1. **First failure** → re-dispatch on the *same* agent with an **enriched prompt** (more context, tighter acceptance criteria, explicit file paths).
2. **Second failure** → escalate to `complex` slot.
3. **Failure on `complex`** → break the task into smaller pieces and restart, or claw back to parent inline.

### Quick Reference

```
Got a task?
│
├─ Conversational / user-watching? ──► parent inline
├─ Pure judgment (planning, review, taste)? ──► parent inline
├─ Trivial-inline 4-condition test passes? ──► parent inline
├─ Needs shell and sandboxPolicy is not "none"? ──► parent Bash
├─ Native Agent tool (Explore/Plan/claude-code-guide)? ──► native tool
└─ Otherwise — labor with a zero-decision brief
      │
      └─► mcp__multi-model-agent__delegate_tasks
            │
            ├─ Brief quality check (readiness)?
            │     └─ NOT_READY → fix brief first
            │
            ├─ agentType: "standard"
            │     ├─ File-only mechanical work? ──► fast, standard
            │     ├─ Needs web research? ──► fast with web_search
            │     └─ Multi-file / integration? ──► reasoner, complex
            │
            └─ On return: quote headline verbatim
                  (or call get_batch_slice(..., "telemetry") if truncated)
```