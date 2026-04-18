# Multi-Model Agent Delegation Rule

## Principle

Parent session = judgment. MCP workers = labor. Never use your expensive model for work a cheaper agent can do.

## Mandatory MCP Dispatch

When this document names an MCP tool, call that MCP tool. No exceptions.

Why: The parent model costs 10-50x more than MCP workers. Every token of labor done inline wastes budget. Self-checks feel productive but bypass the cost model entirely.

1. **Always call the named MCP tool.** Your inline file reads are judgment input, not the audit/review/verification itself.
2. **Always use MCP tools for labor.** The Claude Code `Agent` tool runs on the parent model at parent-model cost. Route implementation through `execute_plan` (plan tasks) or `delegate_tasks` (everything else). Route auditing, reviewing, verifying, and debugging through their specialized tools.
3. **Always complete the full pipeline.** "I'll just do a quick check myself" followed by skipping the MCP call is a violation. The MCP call is the check.
4. **Pipeline steps are non-negotiable.** Every numbered step in the Superpowers Auto-Pipeline that names an MCP tool requires that exact MCP tool call.

### DO / DON'T

```
# After implementing a task:

DO:   Call MCP review_code(filePaths: [changed files])
DON'T: Read the diff yourself and say "looks good"
DON'T: Spawn a Claude Code Agent subagent to review

# When a spec needs auditing:

DO:   Call MCP audit_document(filePaths: [spec_path], auditType: 'correctness')
DON'T: Re-read the spec and list issues yourself
DON'T: Spawn a Claude Code Agent subagent to audit

# When implementing a plan task:

DO:   Call MCP execute_plan with task descriptors and plan file paths
DON'T: Write the code yourself inline
DON'T: Spawn a Claude Code Agent subagent to implement
```

## Tool Routing

The MCP exposes specialized tools for common patterns and a general-purpose dispatch tool. Use the most specific tool that fits.

| Task shape | Tool |
|---|---|
| Audit a spec, plan, or document | `audit_document` |
| Review code for quality/security | `review_code` |
| Verify work against a checklist | `verify_work` |
| Debug a bug or failure | `debug_task` |
| Implement a task that has a written plan/spec file on disk | `execute_plan` |
| No plan file, no specialized route fits — general-purpose labor | `delegate_tasks` |

Specialized tools (`audit_document`, `review_code`, `verify_work`, `debug_task`, `execute_plan`) require less input than `delegate_tasks` because the route structure provides context the MCP would otherwise need from you. Always try a specialized route first. Use `delegate_tasks` only when none of them fit.

`execute_plan` accepts `tasks` (descriptive strings matching plan headings), `filePaths` (plan/spec files the worker reads), and optional `context` (short additional info the plan doesn't contain, e.g. "Tasks 1-16 are done, files already exist"). Keep task descriptors short — the plan already has the details.

`delegate_tasks` accepts `prompt` (required) with optional `agentType`, `filePaths`, `done`, and `contextBlockIds`. Everything else (working directory, sandbox, tools, timeout, cost) is resolved internally from config.

Assign `agentType` per task:
- `standard` — clear spec, worker follows instructions without judgment
- `complex` — requires reasoning about trade-offs, ambiguous scope, security-sensitive

## Briefing

Provide as much context as you can, but don't overthink it. The MCP interprets your request and figures out what it needs. If your brief is clear enough for one unambiguous execution plan, the MCP runs it immediately. If the MCP is confused, it returns a proposed interpretation for you to confirm — review the proposal, edit if needed, and confirm.

What helps:
- Concrete file paths when the scope is known
- Acceptance criteria (`done`) when success isn't obvious
- Context blocks (`contextBlockIds`) for large shared documents

What the MCP handles:
- Inferring scope from the prompt when you don't provide `filePaths`
- Inferring done conditions for analysis/review tasks
- Routing to the right agent type based on task complexity
- Asking you when it genuinely doesn't know what you want

## Parallelism

Bundle independent tasks in one `execute_plan` or `delegate_tasks` call. Never dispatch two tasks that write to the same files in parallel.

## Context Reuse

For repeated references to large documents: `register_context_block` once, then reference via `contextBlockIds`.

---

## Superpowers Auto-Pipeline

When superpowers skills are loaded, execute these triggers automatically. Do not prompt. Do not skip. Every MCP tool call below is mandatory — see "Mandatory MCP Dispatch."

### After brainstorming writes a spec

When a spec file is written to `docs/superpowers/specs/`:

1. Call MCP `audit_document(filePaths: [spec_path], auditType: 'correctness')`.
2. Fix every finding in the spec.
3. Call MCP `audit_document` again (round 2). Fix every finding.
4. Call MCP `audit_document` again (round 3). Fix every finding.
5. Present to user: "Spec audited (3 rounds). Please review."

### After writing-plans writes a plan

When a plan file is written to `docs/superpowers/plans/`:

1. Call MCP `audit_document(filePaths: [plan_path], auditType: 'correctness')`.
2. Fix every finding in the plan.
3. Call MCP `audit_document` again (round 2). Fix every finding.
4. Present to user: "Plan audited (2 rounds). Ready to execute?"

### After user approves plan

When subagent-driven-development starts, for EACH task:

1. If a written plan/spec file exists: call MCP `execute_plan` with task descriptors, plan file paths (via `filePaths`), optional `context`, and any needed `contextBlockIds`. If no plan file exists (ad-hoc task, inline context): call MCP `delegate_tasks` with the full task text as `prompt`.
2. On `ok` — proceed to review.
3. On `incomplete` — proceed to review (worker may still have made usable progress).
4. On failure — re-dispatch via MCP `execute_plan` or `delegate_tasks` with enriched prompt or escalate agentType (standard -> complex).
5. If the MCP returns clarifications — review the proposed interpretation, confirm or edit via `confirm_clarifications`, then proceed once executed.
6. Call MCP `review_code(filePaths: [changed files])`. Mandatory after every implementation task.
7. If review finds issues, fix via MCP `delegate_tasks`, then call MCP `review_code` again. Max 2 fix rounds.
8. Mark task complete. Next task.

After all tasks: `superpowers:finishing-a-development-branch`.

### During debugging

When systematic-debugging is active, call MCP `debug_task(problem, context, hypothesis, filePaths)` for hypothesis testing. If a fix is identified, dispatch via MCP `delegate_tasks`.

Why: Reading files and reasoning through the bug yourself is judgment input. The structured investigation runs on the worker.

### During verification

When verification-before-completion is active, call MCP `verify_work(filePaths, checklist)` before any completion claims.

Why: Self-verification ("I read the files, they look correct") has no external validation. The MCP worker checks independently.

---

## Without Superpowers

Use MCP tools directly per the routing table above.

### Judgment — stay inline

- Brainstorming, choosing approaches, writing plans/specs
- Reviewing delegated output, deciding accept/reject
- Conversational responses

### Labor — delegate via MCP

- Implementing specified changes
- Reading files and summarizing
- Searching codebase for patterns
- Auditing, reviewing, debugging, verifying

### Stay inline exception

Only when ALL five conditions are met:
1. You know exactly what to do.
2. It is 1-2 tool calls.
3. The result is immediately usable.
4. The delegation prompt would be longer than the result.
5. The work is not a Superpowers pipeline step. Pipeline steps always go through MCP regardless of perceived simplicity.

### Shell stays in parent

Run `npm test`, `npm run build`, `git` via Bash. Shell output from delegated workers is not interactively visible — keep build/test commands in your session.

TDD pattern: dispatch edit via MCP `delegate_tasks`, run test yourself, feed failures into follow-up dispatch.

### Code reading

Dispatch survey to standard agent ("summarize data flow in these files"), read only the flagged lines yourself.

Why: Pulling whole files into parent context wastes expensive tokens on content a cheap worker can summarize.

### Response handling

- `ok` — read output, proceed
- `incomplete` — worker ran out of budget; verify files, proceed if usable
- `clarifications` present — the MCP needs your input. Review the proposed interpretation, confirm or edit via `confirm_clarifications`. Do NOT re-dispatch from scratch.
- `timeout` / `cost_exceeded` — break into smaller pieces
- `api_error` / `network_error` — retry once, then escalate agentType (standard -> complex)

### MCP server outage

If the MCP server is unreachable (connection refused, spawn failure, all retries exhausted):

1. **STOP.** Do not proceed with the task.
2. **Report** to the user: "MCP server is down. Cannot delegate."
3. **Wait** for the user to fix the server or give explicit instructions.

"Escalate" in this document always means escalate the **agentType within MCP** (standard -> complex). It never means "do the labor yourself in the parent session."

Why: The parent model exists for judgment — routing, reviewing, deciding — not as a fallback worker. No section of this rule authorizes inline labor as an MCP outage workaround.

Quote the `headline` from every delegation response to the user.