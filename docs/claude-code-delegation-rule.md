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

The MCP's built-in routing is: **capability filter → tier filter → cheapest qualifying provider**. Layer the role mapping below on top.

| Role | Default tier | Default provider | Escalate to |
|---|---|---|---|
| **Implementer** — single file, mechanical, fully-specified brief | `standard` | `minimax` (free) | `sonnet` / `codex` if it needs web fetch or ambiguous integration |
| **Implementer** — multi-file, integration, pattern matching | `standard` | `sonnet` (mid) *or* `codex` if you have no mid tier | `codex` reasoning if the brief still has ambiguity |
| **Implementer** — architecture, design judgment | `reasoning` | `codex` | (top of stack) |
| **Per-task reviewer** (spec compliance) | `standard` | `minimax` (free) | escalate if the review surface is large |
| **Per-task reviewer** (code quality) | `standard` | `sonnet` (mid) *or* `codex` | `codex` reasoning for security-sensitive code |
| **Final whole-branch reviewer** | `reasoning` | `codex`, `effort: "high"` | (top of stack) |

> **Two-tier configs:** if you only have a free provider and a reasoning provider (no mid tier), collapse the middle rows into the reasoning tier. The rule still works — you just have fewer routing options.

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

### Verification of Delegated Output

When a worker returns `status: "ok"`, apply tiered verification:

- **Mechanical task + small diff (≤30 lines) + tests pass** → trust, don't re-read the diff.
- **Larger diff, or judgment-flavored task** → parent reads the diff inline.
- **Security-sensitive code** (auth, payments, JWT, anything in the trust boundary) → parent reads inline **and** dispatches a separate reasoning-tier review pass.
- **Worker said *"I had to make a decision about X"*** → parent reads inline. The worker has confessed that judgment leaked — claw it back.
- **Tests failed** → parent reads the diff to debug.

Tests passing is **necessary but not sufficient** for trust. Don't outsource *"is this the right code"* to the test suite.

### Status Handling

`delegate_tasks` returns one object per task with fields `provider`, `status`, `output`, `turns`, `files`, `usage`, and optionally `error`. The `status` field is one of exactly four protocol values:

| `status` | Meaning | Action |
|---|---|---|
| `ok` | Worker finished normally | Read `output`. Apply tiered verification. Check for any "blocked" / "needs context" markers the worker may have put in its text. |
| `error` | Provider call failed | Read `error`. Usually a capability mismatch, missing API key, or unavailable model. Fix the call; don't blindly retry. |
| `timeout` | Hit `timeoutMs` | Task is too large or the worker is stuck. Break into smaller pieces; don't just raise the timeout. |
| `max_turns` | Hit `maxTurns` | Worker looped. Re-dispatch on a higher-tier provider with a tighter brief, or break the task down. |

**Two layers — don't confuse them.** The four values above are the *protocol* status. Any `DONE` / `BLOCKED` / `NEEDS_CONTEXT` / `DONE_WITH_CONCERNS` conventions (from Superpowers prompt templates, for example) live *inside* the `output` text, not in `status`. A worker can return `status: "ok"` with `output` text saying *"BLOCKED: I need access to the prod config file."* Read both layers.

### Escalation Ladder

**Never retry the same provider with the same prompt. Never escalate without changing something.**

1. **First failure on the cheap provider** → re-dispatch on the *same* provider with an **enriched prompt** (more context, tighter acceptance criteria, explicit file paths).
2. **Second failure on the cheap provider** → escalate to the reasoning tier.
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
