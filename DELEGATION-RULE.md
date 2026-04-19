# Multi-Model Agent Delegation Rule

## Principle

Parent session = judgment. MCP workers = labor. Route all labor to MCP workers — they cost 10-50x less than the parent model.

## Mandatory MCP Dispatch

When this document names an MCP tool, call that MCP tool.

Why: Every token of labor done inline wastes budget. Self-checks feel productive but bypass the cost model entirely.

1. **Call the named MCP tool.** Inline file reads are judgment input, not the audit/review/verification itself.
2. **Use MCP tools for labor.** Route implementation through `execute_plan` (plan tasks) or `delegate_tasks` (everything else). Route auditing, reviewing, verifying, and debugging through their specialized tools.
3. **Complete the full pipeline.** The MCP call IS the check — skipping it is a violation.
4. **Pipeline steps are mandatory.** Every numbered step that names an MCP tool requires that exact MCP tool call.

### DO / DON'T

```
# After implementing a task:
DO:   Call MCP review_code(filePaths: [changed files])
DON'T: Read the diff yourself and say "looks good"
DON'T: Spawn a Claude Code Agent subagent to review

# When a spec needs auditing:
DO:   Call MCP audit_document(filePaths: [spec_path], auditType: 'correctness')
DON'T: Re-read the spec and list issues yourself

# When implementing a plan task:
DO:   Call MCP execute_plan with task descriptors and plan file paths
DON'T: Write the code yourself inline

# When auditing a plan:
DO:   Call MCP review_code(filePaths: [plan_path, ...source_files], focus: ['correctness'])
DON'T: Call audit_document (auditor lacks codebase access, produces low signal)
```

## Tool Routing

Use the most specific tool that fits. Specialized tools require less input because the route provides context.

| Task shape | Tool |
|---|---|
| Audit a spec or document | `audit_document` |
| Audit a plan (references code) | `review_code` with plan + source files |
| Review code for quality/security | `review_code` |
| Verify work against a checklist | `verify_work` |
| Debug a bug or failure | `debug_task` |
| Implement from a plan/spec on disk | `execute_plan` |
| General-purpose labor (no plan file) | `delegate_tasks` |

`execute_plan`: pass `tasks` (matching plan headings), `filePaths` (plan/spec files), optional `context`.

`delegate_tasks`: pass `prompt` (required), optional `agentType`, `filePaths`, `done`, `contextBlockIds`.

Assign `agentType` per task:
- `standard` — clear spec, worker follows instructions
- `complex` — requires reasoning about trade-offs, ambiguous scope, security-sensitive

## Briefing

The MCP interprets your request and infers what it needs. Clear briefs execute immediately; ambiguous ones return a proposed interpretation for you to confirm.

Provide: concrete file paths, acceptance criteria (`done`), context blocks for large shared documents.

## Parallelism

Bundle independent tasks in one `execute_plan` or `delegate_tasks` call. Dispatch tasks that write to the same files sequentially.

Why: Parallel writes to the same file create merge conflicts. The MCP runs tasks concurrently — same-file writes race.

## Context Reuse

For repeated references to large documents: `register_context_block` once, then reference via `contextBlockIds`.

Why: Without context blocks, the same document is transmitted N times for N tasks. Blocks transmit once.

---

## Superpowers Auto-Pipeline

When superpowers skills are loaded, execute these triggers automatically and completely. Every MCP tool call below is mandatory.

### After brainstorming writes a spec

When a spec file is written to `docs/superpowers/specs/`:

1. Call MCP `audit_document(filePaths: [spec_path], auditType: 'correctness')`.
2. Fix every finding in the spec.
3. Call MCP `audit_document` again (round 2). Fix every finding.
4. Call MCP `audit_document` again (round 3). Fix every finding.
5. Present to user: "Spec audited (3 rounds). Please review."

### After writing-plans writes a plan

When a plan file is written to `docs/superpowers/plans/`:

1. Scan the plan for file paths referenced in task descriptions. Collect as `referenced_source_files`.
2. Call MCP `review_code(filePaths: [plan_path, ...referenced_source_files], focus: ['correctness'])`.
3. Fix every finding in the plan.
4. Call MCP `review_code` again (round 2) with the same file list. Fix every finding.
5. Present to user: "Plan audited (2 rounds). Ready to execute?"

Why `review_code` for plans: `audit_document` lacks codebase access and speculates about types/signatures. `review_code` validates the plan's assumptions against actual code.

### After user approves plan

For EACH task in subagent-driven-development:

1. Plan file exists → call MCP `execute_plan` with task descriptors, plan file paths, optional `context`. No plan file → call MCP `delegate_tasks` with the full task text as `prompt`.
2. On `ok` → proceed to review.
3. On `incomplete` → proceed to review (worker may still have made usable progress).
4. On failure → re-dispatch with enriched prompt or escalate agentType (standard → complex).
5. On `clarifications` → review proposed interpretation, confirm or edit via `confirm_clarifications`.
6. Call MCP `review_code(filePaths: [changed files])`. Mandatory after every implementation task.
7. If review finds issues → fix via MCP `delegate_tasks`, then call MCP `review_code` again. Max 2 fix rounds.
8. Mark task complete. Next task.

After all tasks: `superpowers:finishing-a-development-branch`.

### During debugging

Call MCP `debug_task(problem, context, hypothesis, filePaths)` for hypothesis testing. If a fix is identified, dispatch via MCP `delegate_tasks`.

Why: Reading files and reasoning through the bug is judgment input. The structured investigation runs on the worker.

### During verification

Call MCP `verify_work(filePaths, checklist)` before any completion claims.

Why: Self-verification ("I read the files, they look correct") has no external validation. The MCP worker checks independently.

---

## Without Superpowers

Use MCP tools directly per the routing table above.

### Judgment — stay inline

Brainstorming, choosing approaches, writing plans/specs, reviewing delegated output, deciding accept/reject, conversational responses.

### Labor — delegate via MCP

Implementing specified changes, reading files and summarizing, searching codebase for patterns, auditing, reviewing, debugging, verifying.

### Stay inline exception

Only when ALL five conditions are met:
1. You know exactly what to do.
2. It is 1-2 tool calls.
3. The result is immediately usable.
4. The delegation prompt would be longer than the result.
5. The work is not a Superpowers pipeline step.

Why: These conditions ensure delegation overhead exceeds the work itself. Pipeline steps are excluded because skipping them breaks the quality contract.

### Shell stays in parent

Run `npm test`, `npm run build`, `git` via Bash.

Why: Shell output from delegated workers is not interactively visible. Build/test results need to be in your session for judgment.

TDD pattern: dispatch edit via MCP `delegate_tasks`, run test yourself, feed failures into follow-up dispatch.

### Worktree limitation

MCP workers operate in the project root directory. Git worktree isolation does not extend to delegated workers. Keep worktree-aware commands (git add, git commit) in the parent session.

### Code reading

Dispatch survey to standard agent (e.g., `delegate_tasks` with prompt "List all functions in these files that reference X, with line numbers and signatures"), read only the flagged lines yourself.

Why: Pulling whole files into parent context wastes expensive tokens on content a cheap worker can summarize.

### Response handling

| Status | Action |
|---|---|
| `ok` | Read output, proceed |
| `incomplete` | Worker ran out of budget — verify files, proceed if usable |
| `clarifications` | Review proposed interpretation, confirm or edit via `confirm_clarifications` |
| `timeout` / `cost_exceeded` | Break into smaller pieces |
| `api_error` / `network_error` | Retry once, then escalate agentType (standard → complex) |

### Over-delivery review

When a worker's `filesWritten` contains files beyond the task's expected scope, dispatch targeted `review_code` for the extra files. The platform does not constrain over-delivery — unreviewed work is unverified work.

### MCP server outage

If the MCP server is unreachable: **stop and report** "MCP server is down. Cannot delegate." Wait for the user to fix the server or give explicit instructions.

"Escalate" in this document always means escalate the **agentType within MCP** (standard → complex).

Why: The parent model exists for judgment, not as a fallback worker. No section of this rule authorizes inline labor as an MCP outage workaround.

Quote the `headline` from every delegation response to the user.
