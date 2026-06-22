# multi-model-agent

multi-model-agent is the **horizontal harness** for AI engineering: it routes the **right agent to the right task**, enforces quality with **cross-agent review**, and caps spend with **bounded execution**. The bet — **harness quality ≥ a single frontier model, at a fraction of the cost**. It ships as a **public npm package**: install it, bring your own keys, serve it in minutes. **Models go deep; we connect them wide** — and the engineer always keeps the judgment.

---

## The Insight

Models are going deep. We connect them wide.

Every provider — Anthropic, OpenAI, Google, DeepSeek, MiniMax — is racing to make their model better at everything: reasoning, coding, tool use, long context. They're going deeper vertically, and they should. But no single model is the right tool for every task. An expensive frontier model reasoning about architecture is well-spent. That same model grepping files and writing boilerplate is waste.

The value isn't in any one model's depth. It's in the horizontal layer that connects them — routing the right task to the right agent, enforcing quality through cross-agent review, controlling cost through bounded execution, and giving engineers a labor substrate that improves every time a provider ships a better model. The providers go deeper. We connect them wider.

multi-model-agent is that horizontal layer. It runs as a local HTTP service and exposes installable skills to any agent client — Claude Code, Gemini CLI, Codex CLI, Cursor. The agent client stays on judgment (architecture, design, validation, decisions); multi-model-agent handles labor. Routing, supervision, review, cost control, and reporting all happen inside the service. The client never sees provider details; it calls skills exactly as it would call built-in tools.

The three-tier reality this serves:

- **The engineer's own agent** (Opus, GPT-5 — whatever they're talking to) handles architecture, design, brainstorming, and final validation.
- **Complex labor agents** handle advanced tasks — code review, plan auditing, security analysis, spec verification.
- **Standard labor agents** handle the heavy lifting — implementation, file writes, test runs, mechanical work.

We're the layer that makes the second and third tiers work — so the first tier (and the engineer behind it) can stay on what matters.

---

## The Bet

A reviewed multi-agent harness matches or beats a single frontier model — at a fraction of the cost, and we measure it.

Everything here rests on one falsifiable claim:

**A reviewed multi-agent harness delivers quality as good as — or better than — a single frontier model running alone, at a fraction of the cost.**

The reasoning: a solo frontier run is one model, one pass, no independent check. The harness adds structure a single run structurally cannot give itself — the right agent on each task, an independent cross-agent review, and audit gates over the spec and the plan. Running that full harness *on* a frontier model would be ruinously token-expensive. So the harness routes: routine execution to lean standard-tier agents, deep reasoning and review to complex-tier agents, and cross-validates where it matters. The result is controlled quality at a fraction of frontier-alone spend.

This is a bet we hold ourselves to, not a slogan. We **measure** it — savings against a real baseline, issues caught before they ship, quality outcomes — and we report it honestly (see *Evidence and economics are first-class*). If the bet stops being true for a task class, we say so and route that class differently.

---

## The Lifecycle We Harness

We instrument and guard every stage of the development lifecycle; the engineer keeps the judgment — and the lifecycle keeps widening.

The work isn't a flat stream of isolated tasks. It's a **software development lifecycle**, and the harness instruments and guards it end to end. Today that lifecycle looks like:

> investigate / research → spec → plan → execute → review → debug / retry — with **audit** gating the spec and the plan, and a failure loop back to plan.

Each specialized tool is a **rod in the harness** — a gate over one stage of that lifecycle. `investigate` and `research` feed the front; `audit` gates the spec and plan before code is written; `execute_plan` / `delegate` do the building; `review` guards the output; `debug` and `retry_tasks` close the loop. Together they make the lifecycle *observed and defensible* rather than a single uninspected leap from prompt to merge.

**We harness the lifecycle; we do not author it.** The harness enforces evaluation, review, and audit at each gate — but the engineer, through their own agent, makes every call: what to build, which approach, whether to merge. We are the rails and the gates, never the driver. This is the synthesis of "right agent for the right task" and "we help, we don't replace": maximum lifecycle coverage, zero erosion of the engineer's judgment.

**This lifecycle is today's snapshot, not the boundary.** The stages and rods described here are the coverage we have *now*. The platform exists precisely so that coverage keeps widening: new rods (new gates, new task classes), new stages, and richer lifecycle phases get added as the practice of AI software engineering matures. We do not hard-code the lifecycle into the architecture — generic primitives underneath, an open and growing set of rods on top. Whatever the lifecycle of AI-assisted engineering becomes, the harness's job is to instrument and guard more of it over time. The set of rods is meant to grow; the principle that each one is a thin gate over generic machinery does not.

---

## Principles

Nine rules that protect the insight — the right agent per task, structural quality, honest evidence, bounded cost, and platform over models. Each has been tested against real usage.

### 1. Right agent for the right task

Not every task needs the most capable model. Not every task can be handled by the cheapest. Routine execution — implementation, file writes, mechanical work — runs on lean standard-tier agents; deep reasoning, review, and audit run on complex-tier agents. The caller optionally overrides the tier (`agentTier`), the system enforces capability floors silently and infers effort from task shape. The caller's judgment about task complexity is respected; the system ensures the chosen agent can actually do it and is configured to work efficiently. This routing is the engine of The Bet: it is how full-harness quality stays affordable.

### 2. We help, we don't replace

The engineer does judgment. We do labor and gating. We don't make architectural decisions, we don't choose what to build, we don't merge code. We execute what we're told, review it structurally, audit against the spec and plan, and report back with evidence. The engineer stays in control.

### 3. Quality is structural, not aspirational

Self-review has constitutional blind spots. A model cannot reliably catch what it's constitutionally bad at, no matter how many rounds you give it. Quality comes from structure: a *different* agent reviews the work, checking both spec compliance and code quality. This is what makes The Bet real — cross-agent review is the mechanism that makes cheap-tier output trustable to a frontier-alone standard. All task types flow through the same two-phase pipeline by default: implement on one tier, review on the other. Cross-agent review is the structural default for every type, not just artifact-producing tasks. Callers may disable review for task classes where a single model is genuinely sufficient — we make that easy, but the default is always cross-agent.

Findings are **advisory signal for the engineer, not pass/fail gates**. A task can complete cleanly while carrying open concerns — even serious ones — because surfacing a concern is the harness doing its job, not the task failing. The only true failure is a terminal error. We report findings faithfully and let the engineer judge; we never inflate a finding into a failure or bury one to look clean.

The topology may evolve (more review slots, richer routing), but the requirement that implementation and review run on different agents is the structural default.

### 4. Evidence and economics are first-class

We don't just do the labor — we **prove it was worth it**. The economics of the harness must be legible: cost saved against a real frontier-alone baseline, issues caught before shipping, where each task was routed and why, and the quality outcomes. Observability is part of the product, not a reporting afterthought. And the evidence is **honest**: real savings against a real baseline, advisory findings shown as advisory, no vanity metrics that flatter the layer. If a number would mislead, we don't show it. The Bet is only credible if the proof is trustworthy.

### 5. Bounded execution, no surprises

Every task has a cost ceiling and a wall-clock timeout. We never spend more than declared. Within a call, the system owns iterative loops (supervision retries, review rework). Between calls, the engineer orchestrates. No autonomous sessions, no runaway costs, no "the agent decided to refactor your entire codebase."

### 6. The platform is the product, models are configuration

A new model appears, you drop it into a slot. The system — routing, supervision, review, cost ceilings, structured reporting — makes it productive immediately. We never optimize for a specific model. We optimize the system around models. Providers go deeper vertically; we get better at connecting them horizontally.

### 7. Generic works for everyone, specialized works better — and the rod set grows

The core is a generic task dispatcher. Specialized types (`audit`, `review`, `debug`, `execute_plan`, `research`, `investigate`) are opinionated presets — rods — over the same machinery: they set good defaults so callers don't construct full task specs for common patterns. Every rod maps to the same platform primitives; specialization is convenience, not divergence. The set of rods is deliberately **open and expected to grow** as the lifecycle we harness widens — but each new rod earns its place by proving a pattern is universal, and it stays a thin gate over generic primitives. We add rods; we do not accumulate domain logic inside them.

### 8. We should not make agents fail at tasks they can do

If the agent wrote the files and the work evidence is there, the status should reflect that. If a task needs a 2-line edit, the agent has an edit tool. If parallel tasks share a filesystem, they get targeted test commands instead of full-project builds. We trust completion evidence — worker self-assessment backed by file artifacts contributes to status determination alongside review verdicts and validation signals. Platform failures are our failures, not the model's.

### 9. Every tool call is a self-contained unit

Each request takes everything it needs, executes, and returns. No request depends on hidden server-side session state to function — requests may depend on explicit inputs and current workspace state (files on disk), but never on implicit state from a previous call. Context management (`POST /context-blocks`, task polling) is an explicit, caller-controlled content store: the caller registers content, receives an ID, and passes that ID to subsequent calls. We store the content but don't track relationships between calls. Stateless requests, stateful caller.

---

## What We Are

A public npm package you install and serve locally in minutes — a horizontal labor layer any agent client can call.

multi-model-agent ships as a **public npm package** — `@zhixuan92/multi-model-agent`. Any engineer can install it (`npm install -g @zhixuan92/multi-model-agent`, or run it with `npx`) and have the entire layer running locally in minutes. No accounts to provision, no service to sign up for: you bring your own provider keys, install the package, and serve it.

It is a horizontal connection layer delivered as a **local HTTP service**. The engineer runs `mma serve` once; it binds to loopback on a fixed port and stays running across client sessions. Skills are installed per client (`mma sync-skills`), so any supported agent — Claude Code, Gemini CLI, Codex CLI, Cursor — picks up the full tool set without additional configuration. The integration should feel as natural as if the labor agents were built into the client itself.

### Delivery model

```
npm install -g @zhixuan92/multi-model-agent   # public npm package — get it, install it, serve it
mma serve                                  # daemon, stays running on loopback
mma sync-skills                            # writes (and reconciles) skill files in detected clients
```

The daemon owns the long-running process. Skills are thin client-side adapters that point HTTP requests at the daemon. Client sessions come and go; the daemon and its in-memory state (context blocks, batch cache) survive.

### The two-slot model

Users configure two labor agents:

| Slot | Purpose | Examples |
|---|---|---|
| `standard` | Heavy implementation work — file writes, test runs, mechanical tasks | DeepSeek, MiniMax, Claude Haiku |
| `complex` | Advanced labor — code review, plan auditing, spec verification, security analysis | Claude Opus, GPT-5, Claude Sonnet |

These are labor categories, not intelligence tiers. The user decides what "standard" and "complex" mean for their workflow and budget. The engineer's own agent (whatever they're talking to) stays on architecture, design, and final decisions — it never enters our slots.

### The reviewed lifecycle

Every task flows through a two-phase pipeline. Phase one always runs; phase two is the structural default but can be opted out:

1. **Implement** — The actual work. Full tool access, cost ceiling enforcement, sandbox confinement. The pipeline normalizes the brief, infers missing details, shapes effort from task signals, and routes the work; ambiguous briefs proceed with the most likely interpretation rather than pausing for confirmation. Progress heartbeats stream during execution.
2. **Review** — A *different* agent checks both spec compliance and code quality (cross-agent review). Review continues until approved, findings plateau, or the safety limit is reached.

All task types go through both phases by default. Callers may opt out of review (`reviewPolicy: "none"`) for task classes where a single-phase run is sufficient.

### The rods, today

The specialized tools are the harness's current rods over the lifecycle — this is the set we ship now, and it is expected to grow:

**Generic**: `delegate` — the power tool. One or more tasks, full two-phase pipeline. General-purpose fallback when no specialized rod fits.

**Specialized rods**: `audit`, `review`, `debug`, `execute_plan`, `research`, `investigate` — opinionated gates for common lifecycle stages. Each returns a context block ID as an explicit output — the caller passes this ID to subsequent calls to enable delta mode, where round 2+ tracks which prior findings were fixed.

**Orchestration**: `retry_tasks` — task retry operations. Context blocks are managed via a dedicated HTTP endpoint (`POST /context-blocks`), not a task type. These help the caller manage state across calls without us maintaining workflow state.

### What comes back

Structured reports with: status, worker self-assessment, spec review verdict, quality review verdict, files changed, validations run, cost breakdown with saved-cost ROI, and timing. The engineer gets evidence, not just output. Every response carries a headline the caller can quote verbatim — no arithmetic required.

---

## Where We're Going

Seamless protocol, ever-wider lifecycle coverage, undeniable economics — the reviewed harness becomes the unit of AI software engineering.

### Perfect the protocol

The horizontal layer works. But "works" isn't the bar — **seamless** is. The calling agent should delegate to multi-model-agent as naturally as it uses its own built-in tools. No friction, no ceremony, no overhead the engineer has to manage.

- **Intake intelligence** — Understand what the caller wants from minimal input. A terse prompt with file paths should be enough.
- **Response clarity** — Every response gives the caller exactly what it needs to make the next decision. Headlines, structured verdicts, cost evidence. No post-processing, no parsing, no arithmetic.
- **Reliability at scale** — Parallel fan-out across files, graceful handling of provider failures, automatic retry with escalation, bounded execution that never surprises.
- **Provider expansion** — As new providers emerge and existing ones deepen, adding them is configuration, not code.

### Widen the lifecycle

The rods we ship today gate part of the development lifecycle. The roadmap is to **cover more of it** — more rods, more gates, more stages — without ever hard-coding the lifecycle into the platform:

- **More rods** — New specialized gates as patterns prove universal: richer audit types, security and compliance gates, migration and refactor harnesses, release and rollout checks. Each is a thin preset over the same primitives.
- **Caller-defined rods** — Let teams register their own gates at runtime. The shipped presets become seed examples, not the full vocabulary. Teams define their own audit types, review checklists, verification and gating patterns.
- **Provider-aware routing** — Surface which agents handle which task shapes well ("this provider succeeds 95% on TypeScript implementation, 40% on complex refactors"). The caller decides; we inform.
- **Runtime integration** — Embed into client ecosystems as they open extension points: hooks, plugins, IDE extensions. multi-model-agent becomes invisible infrastructure — always available, never in the way.

### Make the economics undeniable

The Bet is only as strong as the proof. We deepen the evidence layer: per-task and fleet-level savings against real baselines, quality-caught accounting, routing transparency, and trend over time — so a team can see, at a glance, that the harness delivers frontier-grade outcomes at a fraction of frontier cost, and can defend that claim to anyone.

### The horizontal layer matures

Models will keep getting deeper — better reasoning, longer context, richer tool use. Each generation makes the vertical providers more capable individually. What won't emerge from any single provider is the horizontal layer that makes a fleet of them behave like one system, nor the harness that gates a whole development lifecycle.

**The reviewed multi-agent harness becomes the unit of AI software engineering.** The way no production system ships without CI/CD, no serious AI-assisted workflow will ship without a routed, reviewed, audited harness. The question shifts from "which model should I use?" to "how is my harness configured, and how wide is its lifecycle coverage?" — an engineering problem, not a model-selection problem.

**The economics compound.** As frontier capability gets more expensive per unit of work, the value of routing the right agent to the right task — and proving the savings — only grows. The layer that connects wide outlives every model generation it works with.

**Providers go deep. We connect wide — and we keep widening.** The bet is that the horizontal harness, and the lifecycle it covers, outlives every model it routes to. We're building that harness.

---

## What We Won't Do

No model-specific hacks, no decisions for you, no hidden state, no autonomy theater, no dressed-up numbers.

**We won't optimize for a specific model.**
When a model has a quirk, the fix goes in the platform (better tools, better supervision, better prompts) — not in model-specific branches. If a workaround only helps one model, it doesn't belong in the platform.

**We won't make decisions for the engineer.**
We execute, review, audit, and report. We don't decide what to build, which approach to take, or whether to merge. We may interpret a terse request into a concrete plan, but the caller controls the intent. The engineer's judgment is input; our output is evidence.

**We won't accumulate domain logic.**
Rods are thin presets over generic primitives. The set of rods grows, but each one stays a thin gate — if a workflow can be achieved by combining existing primitives, it doesn't become a parameter. New rods earn their place by proving a pattern is universal, not by anticipating hypothetical needs.

**We won't maintain workflow state.**
Each request is a self-contained unit — everything it needs comes in, the result goes out. We provide endpoints that help the caller manage its own state across calls (`POST /context-blocks` for content registration, `GET /task/:taskId` for polling). We never infer workflow continuity: no implicit session, no conversation memory. The caller owns the workflow. We own individual task execution.

**We won't chase autonomy.**
The industry is racing toward fully autonomous agents that run for hours. We're building the opposite: bounded execution with structured checkpoints. We run a task, review it, and return. The engineer decides what happens next.

**We won't compete with models.**
When models get better at self-review, our cross-agent review still adds value — different training data, different failure modes, different constitutional biases. But if a single model genuinely becomes sufficient for a task class, we make it easy to route that task to one agent with review turned off. We adapt to what models can do, not to what we wish they couldn't.

**We won't dress up the numbers.**
The economics are the proof, so the proof must be honest. Real savings against a real baseline. Advisory findings shown as advisory, not inflated into failures or hidden to look clean. No vanity metrics that flatter the layer. If a number would mislead the engineer, we don't show it — a north star built on a flattering chart isn't a north star.

---

*This document is the north star. Proposals cite it. Design debates reference it. If a principle needs updating, update it here — not in a proposal footnote.*
