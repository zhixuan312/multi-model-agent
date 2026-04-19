# multi-model-agent — Product Direction

**The north star for what we build, why, and what we refuse.**

This document is the canonical source for product principles. Proposals, specs, and design decisions reference it — not the other way around. When a feature debate needs settling, the answer is here or it gets added here.

---

## The Insight

Models are going deep. We connect them wide.

Every provider — Anthropic, OpenAI, Google, DeepSeek, MiniMax — is racing to make their model better at everything: reasoning, coding, tool use, long context. They're going deeper vertically, and they should. But no single model is the right tool for every task. An expensive frontier model reasoning about architecture is well-spent. That same model grepping files and writing boilerplate is waste.

The value isn't in any one model's depth. It's in the horizontal layer that connects them — routing the right task to the right agent, enforcing quality through cross-agent review, controlling cost through bounded execution, and giving engineers a labor substrate that improves every time a provider ships a better model. The providers go deeper. We connect them wider.

multi-model-agent is that horizontal layer. It sits between the engineer's agent and a fleet of labor agents, making them work together as seamlessly as if they were one system. The engineer stays on judgment — architecture, design, validation, decisions. We handle labor.

The three-tier reality this serves:

- **The engineer's own agent** (Opus, GPT-5 — whatever they're talking to) handles architecture, design, brainstorming, and final validation.
- **Complex labor agents** handle advanced tasks — code review, plan auditing, security analysis, spec verification.
- **Standard labor agents** handle the heavy lifting — implementation, file writes, test runs, mechanical work.

We're the layer that makes the second and third tiers work — so the first tier (and the engineer behind it) can stay on what matters.

---

## Principles

These are the rules that protect the insight. Each one has been tested against real usage.

### 1. The platform is the product, models are configuration

A new model appears, you drop it into a slot. The system — routing, supervision, review, cost ceilings, structured reporting — makes it productive immediately. We never optimize for a specific model. We optimize the system around models. Providers go deeper vertically; we get better at connecting them horizontally.

### 2. Right agent for the right task

Not every task needs the most capable model. Not every task can be handled by the cheapest. The caller declares intent (`agentType`), the system enforces capability floors silently and infers effort from task shape. The caller's judgment about task complexity is respected; the system ensures the chosen agent can actually do it and is configured to work efficiently.

### 3. Quality is structural, not aspirational

Self-review has constitutional blind spots. A model cannot reliably catch what it's constitutionally bad at, no matter how many rounds you give it. Quality comes from structure: a different agent reviews the work, checking both spec compliance and code quality. For tasks that produce file artifacts, cross-agent review is the structural default — it's the mechanism that makes our output trustable. Tasks that produce no file artifacts (audits, analyses, read-only investigations) skip the review topology because there are no artifacts to review; their quality comes from the specialized preset's prompt engineering and output contract instead. The topology may evolve (more review slots, richer routing), but the requirement that artifact-producing implementation and review run on different agents is the structural default. Callers may disable review for task classes where a single model is genuinely sufficient — we make that easy, but the default is always cross-agent.

### 4. Bounded execution, no surprises

Every task has a cost ceiling and a wall-clock timeout. We never spend more than declared. Within a call, the system owns iterative loops (supervision retries, review rework). Between calls, the engineer orchestrates. No autonomous sessions, no runaway costs, no "the agent decided to refactor your entire codebase."

### 5. We should not make agents fail at tasks they can do

If the agent wrote the files and the work evidence is there, the status should reflect that. If a task needs a 2-line edit, the agent has an edit tool. If parallel tasks share a filesystem, they get targeted test commands instead of full-project builds. We trust completion evidence — worker self-assessment backed by file artifacts contributes to status determination alongside review verdicts and validation signals. Platform failures are our failures, not the model's.

### 6. Every tool call is a self-contained unit

Each tool invocation takes everything it needs, executes, and returns. No tool depends on hidden server-side session state to function — tools may depend on explicit inputs and current workspace state (files on disk), but never on implicit state from a previous call. Context management tools (`register_context_block`, `get_batch_slice`) are an explicit, caller-controlled content store: the caller registers content, receives an ID, and passes that ID to subsequent calls. We store the content but don't track relationships between calls. Stateless tools, stateful caller.

### 7. Generic works for everyone, specialized works better

The core is a generic task dispatcher. Specialized tools (`audit_document`, `review_code`, `verify_work`, `debug_task`, `execute_plan`) are opinionated presets over the same machinery — they set good defaults so callers don't construct full task specs for common patterns. The intake pipeline interprets requests and infers missing details, but every specialized tool maps to the same platform primitives. Specialization is convenience, not divergence.

### 8. We help, we don't replace

The engineer does judgment. We do labor. We don't make architectural decisions, we don't choose what to build, we don't merge code. We execute what we're told, review it structurally, and report back with evidence. The engineer stays in control.

---

## What We Are

multi-model-agent is a horizontal connection layer, published as an MCP server. Any MCP client — Claude Code, Codex CLI, Cursor, Gemini CLI, Claude Desktop — connects to it and gets a labor substrate for task delegation. The integration should feel as natural as if the labor agents were built into the client itself.

### The two-slot model

Users configure two labor agents:

| Slot | Purpose | Examples |
|---|---|---|
| `standard` | Heavy implementation work — file writes, test runs, mechanical tasks | DeepSeek-R1, MiniMax, Claude Haiku |
| `complex` | Advanced labor — code review, plan auditing, spec verification, security analysis | Claude Opus, GPT-5, Claude Sonnet |

These are labor categories, not intelligence tiers. The user decides what "standard" and "complex" mean for their workflow and budget. The engineer's own agent (whatever they're talking to) stays on architecture, design, and final decisions — it never enters our slots.

### The reviewed lifecycle

Every task goes through intake and implementation. Artifact-producing tasks also go through cross-agent review:

1. **Intake** — We interpret the request, infer missing details, and compile it into a concrete execution plan. If the intent is clear, execution proceeds immediately. If ambiguous, we return a proposed interpretation for the caller to confirm.
2. **Implement** — The actual work. Full tool access, cost ceiling enforcement, sandbox confinement. We infer effort level from task shape and provide progress heartbeats during execution.
3. **Spec review** — Did the output satisfy the brief? Run by the *other* agent (cross-agent review).
4. **Quality review** — Is the work safe, correct, maintainable? Also the *other* agent. Review continues until approved, findings plateau, or the safety limit is reached.

Non-artifact tasks (audits, analyses, read-only investigations) skip stages 3 and 4 — their quality comes from the specialized preset's prompt engineering and output contract.

### Ten tools, three categories

**Generic**: `delegate_tasks` — the power tool. Batch of tasks, parallel execution, full lifecycle. General-purpose fallback when no specialized route fits.

**Specialized presets**: `audit_document`, `review_code`, `verify_work`, `debug_task`, `execute_plan` — opinionated defaults for common workflows. Each returns a context block ID as an explicit output — the caller passes this ID to subsequent calls to enable delta mode, where round 2+ tracks which prior findings were fixed. We create the content block; the caller controls when and whether to use it.

**Orchestration**: `register_context_block`, `retry_tasks`, `get_batch_slice`, `confirm_clarifications` — context management, batch operations, and clarification workflows. These help the caller manage state across calls without us maintaining workflow state.

### What comes back

Structured reports with: status, worker self-assessment, spec review verdict, quality review verdict, files changed, validations run, cost breakdown with saved-cost ROI, and timing. The engineer gets evidence, not just output. Every response carries a headline the caller can quote verbatim — no arithmetic required.

---

## Where We're Going

### Perfect the protocol

The horizontal layer works. But "works" isn't the bar — **seamless** is. The calling agent should delegate to multi-model-agent as naturally as it uses its own built-in tools. No friction, no ceremony, no overhead the engineer has to manage.

What this means concretely:

- **Intake intelligence** — We should understand what the caller wants from minimal input. A terse prompt with file paths should be enough. The intake pipeline interprets, infers, and executes — or asks one precise clarifying question. Never force the caller to construct elaborate task specs for straightforward work.
- **Response clarity** — Every response should give the caller exactly what it needs to make the next decision. Headlines, structured verdicts, cost evidence. No post-processing, no parsing, no arithmetic. The caller quotes the result and moves on.
- **Reliability at scale** — Parallel fan-out across files, graceful handling of provider failures, automatic retry with escalation, bounded execution that never surprises. multi-model-agent should be the most predictable thing in the stack.
- **Provider expansion** — As new providers emerge and existing ones deepen, adding them should be configuration, not code. The routing layer, tool adapters, and model profiles absorb new providers without platform changes.

### Deepen the connection

Once the protocol is seamless, go deeper into the ecosystems we connect:

- **Provider-aware routing** — Track which agents handle which task shapes well. Not to replace the caller's judgment, but to surface patterns: "this provider succeeds 95% on TypeScript implementation tasks, 40% on complex refactors." The caller decides; we inform.
- **Workflow templates** — Let callers register custom task templates at runtime. The specialized presets become seed examples, not the full vocabulary. Teams define their own audit types, review checklists, verification patterns.
- **Runtime integration** — Embed into provider ecosystems as they open extension points. Claude Code hooks, Codex plugins, IDE extensions. multi-model-agent becomes invisible infrastructure — always available, never in the way.

### The horizontal layer matures

Models will keep getting deeper — better reasoning, longer context, richer tool use. Each generation makes the vertical providers more capable individually. What won't emerge from any single provider is the horizontal layer that makes a fleet of them behave like one system.

**multi-model-agent becomes the engineer's runtime.** Tasks flow in from the engineer's agent, get routed, executed, reviewed, and reported. The engineer sees structured results, not raw model output. We handle retry, escalation, cost control, and quality assurance autonomously within declared bounds.

**Multi-agent development becomes the default.** The same way no production system runs on a single server, no serious AI-assisted development workflow will run on a single model. The question shifts from "which model should I use?" to "how is my multi-model setup configured?" — and that's an engineering problem, not a model selection problem.

**Providers go deep. We connect wide.** The bet is that the horizontal layer outlives every model generation it works with. We're building that layer.

---

## What We Won't Do

**We won't optimize for a specific model.**
When a model has a quirk, the fix goes in the platform (better tools, better supervision, better prompts) — not in model-specific branches. If a workaround only helps one model, it doesn't belong in the platform. Providers go deep on their own; we stay horizontal.

**We won't make decisions for the engineer.**
We execute, review, and report. We don't decide what to build, which approach to take, or whether to merge. We may interpret a terse request into a concrete plan, but the caller controls the intent. Cost ceilings are set by the caller, not suggested. The engineer's judgment is input; our output is evidence.

**We won't accumulate domain logic.**
Specialized tools are thin presets over generic primitives. If a workflow can be achieved by combining existing primitives (prompt text + `contextBlockIds` + tool mode), it doesn't become a parameter. New presets earn their place by proving a pattern is universal enough to warrant a default, not by anticipating hypothetical needs.

**We won't maintain workflow state.**
Each tool call is a self-contained unit — everything it needs comes in, the result goes out. We provide tools that help the caller manage its own state across calls (`register_context_block`, `get_batch_slice`). We may persist explicit content blobs and return system-generated IDs for them, but we never infer workflow continuity from them — there is no implicit session, no conversation memory, no "the system remembers what you asked last time." The caller owns the workflow. We own individual task execution. This boundary is what makes multi-model-agent predictable and the cost model honest.

**We won't chase autonomy.**
The industry is racing toward fully autonomous agents that run for hours. We're building the opposite: bounded execution with structured checkpoints. We run a task, review it, and return. The engineer decides what happens next. Autonomy is the caller's problem — we provide the reliable labor substrate they orchestrate.

**We won't compete with models.**
When models get better at self-review, our cross-agent review still adds value — different training data, different failure modes, different constitutional biases. But if a single model genuinely becomes sufficient for a task class, we don't fight that. We make it easy to route that task to one agent with review turned off. We adapt to what models can do, not to what we wish they couldn't.

---

*This document is the north star. Proposals cite it. Design debates reference it. If a principle needs updating, update it here — not in a proposal footnote.*
