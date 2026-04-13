# Multi-Model Agent Delegation Rule

This rule requires the `multi-model-agent` MCP server registered at user scope.
If `mcp__multi-model-agent__delegate_tasks` is not available, this rule does not apply.

## Installation

```bash
# Global (every project)
mkdir -p ~/.claude/rules
curl -o ~/.claude/rules/multi-model-delegation.md \
  https://raw.githubusercontent.com/zhixuan312/multi-model-agent/HEAD/docs/claude-code-delegation-rule.md
```

Restart Claude Code after installing.

---

## The Principle

Parent session = judgment. MCP workers = labor.

Your model is expensive. Use it for decisions, architecture, brainstorming, and review synthesis. Use `multi-model-agent` MCP tools for everything else: implementation, file edits, code review, auditing, debugging, verification.

Every task you'd hand to a skilled junior engineer belongs in the MCP fleet. Everything that requires senior judgment stays in your session.

---

## Tool Routing

Use the specialized tool when the task matches. Use `delegate_tasks` for everything else.

| Task shape | Tool | agentType |
|---|---|---|
| Audit a spec, plan, or document | `audit_document` | complex (default) |
| Review code for quality/security | `review_code` | complex (default) |
| Verify work against a checklist | `verify_work` | standard (default) |
| Debug a bug or failure | `debug_task` | complex (default) |
| Implementation tasks from a plan | `delegate_tasks` | per task (see below) |
| Research / codebase exploration / grep | `delegate_tasks` | standard |

### agentType routing for implementation

When executing a plan with N tasks, assign each task's `agentType` individually based on its nature:

- `standard` — the task has a clear spec, the worker follows instructions without judgment calls
- `complex` — the task requires reasoning about trade-offs, has ambiguous scope, or is security-sensitive

A batch of 10 tasks might be 6 standard and 4 complex, or any other mix. The decision is per-task, not per-batch.

### Brief discipline

Every `delegate_tasks` prompt must be a **zero-decision brief**: the worker executes without making design or scope calls. Include:
- Exact file paths
- Exact scope ("single file, no other files change")
- Acceptance criteria ("tests pass, schema validates")
- Full context (worker has no memory of your session)

The sharper the brief, the cheaper the delegation.

### Common fields for all dispatches

Always set:
- `cwd` — absolute project root or worktree path
- `sandboxPolicy: "cwd-only"` — default, keep it unless shell is genuinely needed

### Parallelism

Independent tasks in one `delegate_tasks` call run concurrently. Bundle them. Never dispatch two tasks that write to the same files in parallel.

### Context reuse

For repeated dispatches referencing the same large document:
1. `register_context_block` with the content
2. Reference via `contextBlockIds` in subsequent tasks

Avoids re-transmitting long briefs on every call.

---

## Superpowers Integration (automatic)

If superpowers skills are loaded, the following MCP triggers are **mandatory and automatic**. Do not prompt the user. Do not skip steps. Execute them as part of the pipeline.

### After brainstorming writes a spec

When `superpowers:brainstorming` writes a spec file to `docs/superpowers/specs/`:

1. Read the spec file.
2. Call `audit_document(filePaths: [spec_path], auditType: 'correctness', agentType: 'complex')`.
3. Read the audit findings. Fix every issue in the spec file.
4. Call `audit_document` again with the updated spec (round 2).
5. Read findings. Fix every issue.
6. Call `audit_document` again (round 3).
7. Read findings. Fix every issue.
8. THEN present the spec to the user for review. Tell the user: "Spec audited (3 rounds, all findings addressed). Please review."

### After writing-plans writes a plan

When `superpowers:writing-plans` writes a plan file to `docs/superpowers/plans/`:

1. Read the plan file.
2. Call `audit_document(filePaths: [plan_path], auditType: 'correctness', agentType: 'complex')`.
3. Read findings. Fix every issue in the plan file.
4. Call `audit_document` again (round 2).
5. Read findings. Fix every issue.
6. THEN present the plan to the user for approval. Tell the user: "Plan audited (2 rounds, all findings addressed). Ready to execute?"

### After user approves plan — implementation

When the user approves the plan and `superpowers:subagent-driven-development` starts:

For EACH task in the plan:

1. Assign `agentType` based on task nature (`standard` or `complex`).
2. Dispatch via `delegate_tasks` with:
   - Full task text as `prompt` (do not make the worker read the plan file)
   - `cwd` set to the project or worktree root
   - `sandboxPolicy: 'cwd-only'`
   - `tools: 'full'`
3. Check the result status:
   - `ok` with `workerStatus: 'done'` → proceed to review
   - `incomplete` with `workerStatus: 'done'` → verify files changed, proceed to review if work is done
   - Any other failure → re-dispatch with enriched prompt or escalate `agentType`
4. AUTOMATICALLY run `review_code(filePaths: [files changed by the task], agentType: 'complex')`.
5. If review finds issues:
   - Dispatch a fix via `delegate_tasks` with the review findings as context
   - Re-run `review_code` on the fixed files
   - Repeat until review passes (max 2 fix rounds)
6. Mark task complete. Move to next task.

After ALL tasks complete:
- Use `superpowers:finishing-a-development-branch` as normal.

### During systematic debugging

When `superpowers:systematic-debugging` is active:

- Use `debug_task(problem, context, hypothesis, filePaths)` for Phase 3 (hypothesis testing).
- Include relevant file paths so the agent can inspect the code.
- If `debug_task` identifies a fix, dispatch implementation via `delegate_tasks`.

### During verification

When `superpowers:verification-before-completion` is active:

- Use `verify_work(filePaths: [relevant files], checklist: [items from plan/spec])` before making any completion claims.

---

## Standalone Usage (without Superpowers)

If superpowers skills are NOT loaded, use the MCP tools directly based on the task routing table above. The following decision procedure applies:

### When to delegate

For every task, ask: is this judgment or labor?

**Judgment — do it yourself:**
- Brainstorming with the user
- Choosing between approaches
- Writing plans and specs
- Reviewing delegated output and deciding accept/reject
- Conversational responses

**Labor — delegate via MCP:**
- Implementing a specified change
- Reading files and summarizing contents
- Searching the codebase for patterns
- Auditing a document for issues
- Reviewing code for quality
- Debugging a failure
- Verifying work against requirements

**Mixed** — do the judgment part yourself (decide what to build, which approach, what the acceptance criteria are), then delegate the labor part with a zero-decision brief.

### When to stay inline

Handle inline only when ALL four are true:
1. You already know exactly what to do
2. It's one tool call, maybe two
3. The result is immediately usable
4. The prompt you'd write to delegate would be longer than the result

### Shell stays in parent

Keep `npm test`, `npm run build`, `git` commands, and other shell operations in your own session via the Bash tool. Delegated workers run in isolated contexts where shell output is harder to inspect.

**TDD pattern:** dispatch the edit via `delegate_tasks`, run the test yourself via Bash, feed test output into a follow-up dispatch if fixes are needed.

### Reading code efficiently

Don't pull entire files into your expensive context. Instead:
1. Dispatch a survey to standard agent: "Read these files, summarize the data flow"
2. Read only the specific lines the survey flagged
3. Form your judgment from the small surface you actually read

### Status handling

| `status` | Action |
|---|---|
| `ok` | Read output, proceed |
| `incomplete` | Check `workerStatus` — if `done`, verify files and proceed |
| `max_turns` | Re-dispatch with tighter brief or escalate agentType |
| `timeout` | Break into smaller pieces |
| `api_error` / `network_error` | Retry or escalate |

Always quote the `headline` from the response to the user after delegation.
