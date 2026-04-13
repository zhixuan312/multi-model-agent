# Multi-Model Agent Delegation Rule

## Principle

Parent session = judgment. MCP workers = labor. Never use your expensive model for work a cheaper agent can do.

## Tool Routing

| Task shape | Tool | agentType |
|---|---|---|
| Audit a spec, plan, or document | `audit_document` | complex |
| Review code for quality/security | `review_code` | complex |
| Verify work against a checklist | `verify_work` | standard |
| Debug a bug or failure | `debug_task` | complex |
| Implementation from a plan | `delegate_tasks` | per task |
| Research / codebase exploration | `delegate_tasks` | standard |

When executing a plan, assign `agentType` per task based on nature:
- `standard` — clear spec, worker follows instructions without judgment
- `complex` — requires reasoning about trade-offs, ambiguous scope, security-sensitive

Set `cwd` (absolute project root) on any dispatch that reads or writes files. Set `sandboxPolicy: 'cwd-only'` unless the task genuinely needs shell access or paths outside the project.

## Brief Discipline

Every `delegate_tasks` prompt must be zero-decision: exact file paths, exact scope, acceptance criteria, full context. The worker has no memory of your session.

## Parallelism

Bundle independent tasks in one `delegate_tasks` call. Never dispatch two tasks that write to the same files in parallel.

## Context Reuse

For repeated references to large documents: `register_context_block` once, then reference via `contextBlockIds`.

---

## Superpowers Auto-Pipeline

When superpowers skills are loaded, execute these triggers automatically. Do not prompt. Do not skip.

### After brainstorming writes a spec

When a spec file is written to `docs/superpowers/specs/`:

1. `audit_document(filePaths: [spec_path], auditType: 'correctness', agentType: 'complex')`
2. Fix every finding in the spec.
3. `audit_document` again (round 2). Fix every finding.
4. `audit_document` again (round 3). Fix every finding.
5. Present to user: "Spec audited (3 rounds). Please review."

### After writing-plans writes a plan

When a plan file is written to `docs/superpowers/plans/`:

1. `audit_document(filePaths: [plan_path], auditType: 'correctness', agentType: 'complex')`
2. Fix every finding in the plan.
3. `audit_document` again (round 2). Fix every finding.
4. Present to user: "Plan audited (2 rounds). Ready to execute?"

### After user approves plan

When subagent-driven-development starts, for EACH task:

1. Assign `agentType` per task nature.
2. `delegate_tasks` with full task text as prompt, `cwd`, `sandboxPolicy: 'cwd-only'`, `tools: 'full'`.
3. On `ok`/`incomplete` with `workerStatus: 'done'` → proceed to review.
4. On failure → re-dispatch with enriched prompt or escalate agentType.
5. `review_code(filePaths: [changed files], agentType: 'complex')` — automatic, no prompt.
6. If review finds issues → fix via `delegate_tasks`, re-review. Max 2 fix rounds.
7. Mark task complete. Next task.

After all tasks: `superpowers:finishing-a-development-branch`.

### During debugging

When systematic-debugging is active, use `debug_task(problem, context, hypothesis, filePaths)` for hypothesis testing. If a fix is identified, dispatch via `delegate_tasks`.

### During verification

When verification-before-completion is active, use `verify_work(filePaths, checklist)` before any completion claims.

---

## Without Superpowers

Use MCP tools directly per the routing table above.

### Judgment — stay inline

- Brainstorming, choosing approaches, writing plans/specs
- Reviewing delegated output, deciding accept/reject
- Conversational responses

### Labor — delegate

- Implementing specified changes
- Reading files and summarizing
- Searching codebase for patterns
- Auditing, reviewing, debugging, verifying

### Stay inline exception

Only when ALL four: you know exactly what to do, it's 1-2 tool calls, result is immediately usable, the delegation prompt would be longer than the result.

### Shell stays in parent

Run `npm test`, `npm run build`, `git` via Bash. Delegated workers can't surface shell output.

TDD pattern: dispatch edit via `delegate_tasks`, run test yourself, feed failures into follow-up dispatch.

### Code reading

Don't pull whole files into parent context. Dispatch survey to standard agent ("summarize data flow in these files"), read only the flagged lines yourself.

### Status handling

- `ok` → read output, proceed
- `incomplete` + `workerStatus: 'done'` → verify files, proceed
- `max_turns` → tighter brief or escalate agentType
- `timeout` → break into smaller pieces
- `api_error` / `network_error` → retry or escalate

Quote the `headline` from every delegation response to the user.
