# Multi-Model Agent Delegation Rule for Claude Code

Drop-in rule that teaches Claude Code **when** to delegate work to `multi-model-agent` instead of burning context in its own session. Pairs especially well with the [Superpowers](https://github.com/obra/superpowers) skill set, but works on its own too.

## What this rule gives you

- **Context savings.** Claude Code's native `Task` / `Agent` tool runs subagents that inherit the same expensive model your parent session is running. This rule redirects implementation and review work through `delegate_tasks`, which runs on separate, clean contexts — your parent session's window stays lean.
- **Cost routing.** Mechanical work gets routed to free / cheap providers. Reasoning-tier work escalates to expensive providers only when the task needs it.
- **Concurrency.** Independent tasks dispatched in one `delegate_tasks` call run in parallel.
- **Clear rules about what to delegate vs. what to keep inline**, so Claude Code doesn't over-delegate trivial reads or under-delegate big work.

## Prerequisites

1. `multi-model-agent` MCP registered at **user scope** — see the main [README](../README.md#4-register-the-mcp-server).
2. A `~/.multi-model/config.json` with at least two providers at different cost tiers. The routing table below assumes you have providers named `minimax` (free), `sonnet` (mid), and `codex` (reasoning). If your config uses different names, **substitute your own names** throughout the table.
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

Everything below this line is the rule content Claude Code will read. Copy from here down if you're pasting into an existing instruction file.

### Scope — when this rule applies

When executing development work that would normally dispatch a Claude-native subagent (the `Task` / `Agent` tool), use the **`mcp__multi-model-agent__delegate_tasks`** MCP tool instead. This applies specifically to *implementation* and *review* dispatches — not to research or help-style agents.

**Use `mcp__multi-model-agent__delegate_tasks` for:**

- Any subagent dispatched by `superpowers:subagent-driven-development` — implementer, spec reviewer, code-quality reviewer, final reviewer.
- Any subagent dispatched by `superpowers:executing-plans` for plan execution.
- Any time you would otherwise call `Agent` with `subagent_type: "general-purpose"` to *write code, run tests, or review code*.
- Code review dispatched via `superpowers:requesting-code-review` and `superpowers:code-reviewer`.

**Keep using the Claude-native `Agent` tool for:**

- `subagent_type: "Explore"` — fast codebase exploration. The delegated providers don't have your session's grep/glob priors and would re-discover everything.
- `subagent_type: "Plan"` — architecture planning that needs to integrate into the running session.
- `subagent_type: "claude-code-guide"`, `statusline-setup`, and any other specialized agents listed in the system prompt.
- Shell-heavy or shell-risky tasks by default. `shell` is a supported capability when the provider or task sets `sandboxPolicy: "none"`, but delegated providers run outside your session's Bash, so failures are harder to inspect and an escaped process is harder to interrupt. Keep `pnpm`/`pytest`/`tsc`/`git` on the native `Agent` tool unless you've *intentionally* set `sandboxPolicy: "none"` for a task you trust.
- Quick lookups you'd normally do inline — don't delegate trivial reads.

### Provider routing

Apply the MCP's own routing rules: capability filter → tier filter → cheapest qualifying provider. Then layer the role mapping below.

> Provider names `minimax`, `sonnet`, and `codex` refer to entries in your `~/.multi-model/config.json`. If you named them differently, substitute your own names.

| Role | Default tier | Default provider | Escalate to |
|---|---|---|---|
| **Implementer** — single file, mechanical, well-specified | `standard` | `minimax` (free) | `sonnet` if it needs web fetch |
| **Implementer** — multi-file, integration, pattern matching | `standard` | `sonnet` | `codex` if ambiguous |
| **Implementer** — architecture, ambiguous spec, design judgment | `reasoning` | `codex` | (top tier) |
| **Spec compliance reviewer** | `standard` | `minimax` (free) | `sonnet` if review surface is large |
| **Code quality reviewer** (per task) | `standard` | `sonnet` | `codex` for security-sensitive or architectural code |
| **Final code reviewer** (whole implementation) | `reasoning` | `codex` | (top tier) |

**Capability hints:**

- Most providers expose `file_read`, `file_write`, `grep`, `glob`. Always pass these as `requiredCapabilities` for code work.
- `web_search` and `web_fetch` are provider-specific — add them to `requiredCapabilities` only when the task truly needs them, otherwise you'll over-constrain routing.
- `shell` is only advertised as a capability when the provider (or the task) has `sandboxPolicy: "none"`. If you *do* need to delegate a shell task, pass `sandboxPolicy: "none"` on the task and include `"shell"` in `requiredCapabilities` — routing will then pick a provider whose sandbox is open. Default to native `Agent` for shell unless you have a reason to delegate.

**Effort knob:**

- Reasoning-tier providers (e.g. `codex`) honor the `effort` field. Use `effort: "high"` for final reviews and architecture tasks; `effort: "medium"` is the default for normal reasoning-tier work.

### How to dispatch

Replace each `Task` / `Agent` invocation with a `mcp__multi-model-agent__delegate_tasks` call. The body of the prompt is **identical** — paste the same task content you would have handed to a native subagent, including full scene-setting context. Do not ask the delegated agent to read the plan file; hand it the relevant excerpt directly.

Always set:

- `cwd` — the worktree or repo root the agent should operate in (e.g. `/path/to/your/project`).
- `sandboxPolicy: "cwd-only"` — keep file writes confined to the working directory. Only relax this when the task legitimately needs to touch sibling repos.
- `tier`, `provider`, `requiredCapabilities` per the table above.

**Parallelize when safe.** If two implementer tasks are independent (different files, no shared state), put them in the same `tasks` array — they'll run concurrently. Spec reviewer + code-quality reviewer for the *same* task are sequential (the reviewer needs to see the implementer's output), so dispatch them in separate calls. **Never** dispatch two implementer tasks in parallel that could conflict on the same files.

### Writing plans that delegate well (for Superpowers users)

The routing table above only works if each task in your plan gives Claude Code enough signal to pick a provider. When using `superpowers:writing-plans`, write each task with:

1. **Explicit file paths** — `"edit src/foo.ts:42 to add field X"`, not `"update the types"`. Specific paths → mechanical tier (free provider).
2. **Explicit scope size** — "single file, mechanical" / "multi-file integration" / "ambiguous design". These phrases map directly to the table rows.
3. **Explicit capabilities needed** — mention if the task needs `web_search`, `web_fetch`, or `shell`. If you say "run the tests after", Claude Code will (correctly) keep the task on the native `Agent` tool.
4. **Explicit difficulty** — one of the three implementer rows in the table. "Mechanical", "integration", or "architectural / design judgment".

Example task text that routes cleanly:

```
Task 3 (mechanical, single file): In src/config.ts, add a
`timeoutMs` field to the Config Zod schema with a default of 600000
and positive-integer validation. No other files should change. No
tests need to run.
```

→ Claude Code routes this to `minimax`, tier `standard`, capabilities `[file_read, file_write]`.

Vague task text that forces escalation:

```
Task 3: Make the timeout configurable.
```

→ Claude Code has to guess: multiple files? Schema change? New CLI flag? Default gets routed to `sonnet` or escalated to `codex`, wasting budget.

**The more specific your plan, the cheaper your delegation.**

### Status handling

`delegate_tasks` returns one object per task with fields `provider`, `status`, `output`, `turns`, `files`, `usage`, and optionally `error`. The `status` field is one of exactly four values — treat them like this:

- **`ok`** — the run completed normally. Still read `output`: the sub-agent may have reported partial success, unresolved questions, or concerns in its text. If it did, surface them to the user before moving on.
- **`max_turns`** — the sub-agent ran to the configured `maxTurns` ceiling without finishing. Don't silently retry on the same provider with the same prompt; either raise `maxTurns` for the task, trim the scope, or escalate the provider tier (e.g. `minimax` → `sonnet` → `codex`).
- **`timeout`** — the task hit `timeoutMs`. Same rule: don't blind-retry. Raise `timeoutMs`, shrink the task, or escalate the tier if the work is genuinely harder than the tier you picked.
- **`error`** — inspect the `error` field. If it's a capability mismatch or config problem, fix the dispatch and re-run. If it's a provider-side failure on mechanical work, retry once on the same provider; if it fails again, escalate the tier.

For any non-`ok` status, always read `output` and `error` before deciding whether to retry, re-dispatch on the native `Agent` tool (e.g. when the task actually needed shell you didn't grant), or ask the user for guidance.

### Quick reference

```
Want to dispatch an implementer / reviewer subagent?
│
├─ Needs pnpm/pytest/git/shell and you haven't opted into
│   sandboxPolicy: "none"? ──► native Agent tool
├─ Is "Explore" / "Plan" / "claude-code-guide"? ──► native Agent tool
└─ Otherwise ──► mcp__multi-model-agent__delegate_tasks
                  │
                  ├─ Mechanical 1-2 file edit? ──► free tier, standard
                  ├─ Multi-file integration? ──► mid tier, standard
                  ├─ Architecture / final review? ──► reasoning tier, effort: high
                  └─ Spec compliance check? ──► free tier, standard
```
