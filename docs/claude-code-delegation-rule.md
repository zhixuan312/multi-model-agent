# Multi-Model Agent Delegation Rule

## Principle

Parent session = judgment. MCP workers = labor. Never use your expensive model for work a cheaper agent can do.

## Mandatory MCP Dispatch

When this document names an MCP tool (`audit_document`, `review_code`, `verify_work`, `debug_task`, `delegate_tasks`), call that MCP tool. No exceptions.

Why: The parent model costs 10-50x more than MCP workers. Every token of labor done inline wastes budget. Self-checks feel productive but bypass the cost model entirely.

1. **Always call the named MCP tool.** Your inline file reads are judgment input, not the audit/review/verification itself.
2. **Always use MCP `delegate_tasks` for labor.** The Claude Code `Agent` tool runs on the parent model at parent-model cost. Route implementation, auditing, reviewing, verifying, and debugging through MCP.
3. **Always complete the full pipeline.** "I'll just do a quick check myself" followed by skipping the MCP call is a violation. The MCP call is the check.
4. **Pipeline steps are non-negotiable.** Every numbered step in the Superpowers Auto-Pipeline that names an MCP tool requires that exact MCP tool call.

### DO / DON'T

```
# After implementing a task:

DO:   Call MCP review_code(filePaths: [changed files], agentType: 'complex')
DON'T: Read the diff yourself and say "looks good"
DON'T: Spawn a Claude Code Agent subagent to review

# When a spec needs auditing:

DO:   Call MCP audit_document(filePaths: [spec_path], auditType: 'correctness', agentType: 'complex')
DON'T: Re-read the spec and list issues yourself
DON'T: Spawn a Claude Code Agent subagent to audit

# When implementing a plan task:

DO:   Call MCP delegate_tasks with full brief, cwd, sandboxPolicy
DON'T: Write the code yourself inline
DON'T: Spawn a Claude Code Agent subagent to implement
```

## Tool Routing

| Task shape | Tool | agentType |
|---|---|---|
| Audit a spec, plan, or document | `audit_document` | complex |
| Review code for quality/security | `review_code` | complex |
| Verify work against a checklist | `verify_work` | standard |
| Debug a bug or failure | `debug_task` | complex |
| Implementation from a plan | `delegate_tasks` | per task |
| Research / codebase exploration | `delegate_tasks` | standard |

Assign `agentType` per task:
- `standard` — clear spec, worker follows instructions without judgment
- `complex` — requires reasoning about trade-offs, ambiguous scope, security-sensitive

Set `cwd` (absolute project root) on any dispatch that reads or writes files. Set `sandboxPolicy: 'cwd-only'` unless the task genuinely needs shell access or paths outside the project.

## Brief Discipline

Every `delegate_tasks` prompt must be zero-decision: exact file paths, exact scope, acceptance criteria, full context.

Why: The worker has no memory of your session. Vague briefs produce vague results and waste tokens on clarification loops.

## Parallelism

Bundle independent tasks in one `delegate_tasks` call. Never dispatch two tasks that write to the same files in parallel.

## Context Reuse

For repeated references to large documents: `register_context_block` once, then reference via `contextBlockIds`.

---

## Superpowers Auto-Pipeline

When superpowers skills are loaded, execute these triggers automatically. Do not prompt. Do not skip. Every MCP tool call below is mandatory — see §"Mandatory MCP Dispatch."

### After brainstorming writes a spec

When a spec file is written to `docs/superpowers/specs/`:

1. Call MCP `audit_document(filePaths: [spec_path], auditType: 'correctness', agentType: 'complex')`.
2. Fix every finding in the spec.
3. Call MCP `audit_document` again (round 2). Fix every finding.
4. Call MCP `audit_document` again (round 3). Fix every finding.
5. Present to user: "Spec audited (3 rounds). Please review."

### After writing-plans writes a plan

When a plan file is written to `docs/superpowers/plans/`:

1. Call MCP `audit_document(filePaths: [plan_path], auditType: 'correctness', agentType: 'complex')`.
2. Fix every finding in the plan.
3. Call MCP `audit_document` again (round 2). Fix every finding.
4. Present to user: "Plan audited (2 rounds). Ready to execute?"

### After user approves plan

When subagent-driven-development starts, for EACH task:

1. Assign `agentType` per task nature.
2. Call MCP `delegate_tasks` with full task text as prompt, `cwd`, `sandboxPolicy: 'cwd-only'`. Use `tools: 'full'` for implementation, `tools: 'readonly'` for read-only tasks.
3. On `ok`/`incomplete` with `workerStatus: 'done'` — proceed to review.
4. On failure — re-dispatch via MCP `delegate_tasks` with enriched prompt or escalate agentType (standard -> complex).
5. Call MCP `review_code(filePaths: [changed files], agentType: 'complex')`. Mandatory after every implementation task.
6. If review finds issues — fix via MCP `delegate_tasks`, then call MCP `review_code` again. Max 2 fix rounds.
7. Mark task complete. Next task.

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

### Status handling

- `ok` — read output, proceed
- `incomplete` + `workerStatus: 'done'` — verify files, proceed
- `brief_too_vague` — sharpen the brief (add file paths, scope, acceptance criteria)
- `max_turns` — tighter brief or escalate agentType (standard -> complex)
- `timeout` — break into smaller pieces
- `cost_exceeded` — break into smaller pieces or raise `maxCostUSD`
- `api_error` / `network_error` / `api_aborted` — retry once, then escalate agentType (standard -> complex)

### MCP server outage

If the MCP server is unreachable (connection refused, spawn failure, all retries exhausted):

1. **STOP.** Do not proceed with the task.
2. **Report** to the user: "MCP server is down. Cannot delegate."
3. **Wait** for the user to fix the server or give explicit instructions.

"Escalate" in this document always means escalate the **agentType within MCP** (standard -> complex). It never means "do the labor yourself in the parent session."

Why: The parent model exists for judgment — routing, reviewing, deciding — not as a fallback worker. No section of this rule authorizes inline labor as an MCP outage workaround.

Quote the `headline` from every delegation response to the user.
