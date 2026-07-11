# multi-model-agent (engine) — Product Guidelines

> The engine is MMA's labor layer and its individual (power-user) mode: it routes
> the right agent to the right task, enforces quality through cross-agent review,
> and returns evidence — called directly from whatever agent client the engineer
> already uses.

## Role in the MMA product

The engine is the underlying **labor layer** and the **individual adoption mode**.
It ships as the public npm package `@zhixuan92/multi-model-agent`, runs as a local
HTTP daemon on loopback, and exposes installable skills to any agent client
(Claude Code, Codex CLI, Cursor, Gemini CLI). Forge is built on top of it over
HTTP; telemetry reports on it. The global north star is `DIRECTION.md`; this
document carries the engine's product-specific direction — the parts of the old
engine-scoped DIRECTION that are engine *mechanism*, not whole-product bet.

## Product-specific principles

1. **Right agent for the right task.** Routine execution runs on lean
   `standard`-tier agents; deep reasoning, review, and audit run on `complex`-tier
   agents. The caller may override the tier (`agentTier`); the system enforces
   capability floors silently and infers effort from task shape. This routing is
   the engine of The Bet.
2. **Generic works for everyone, specialized works better — and the rod set
   grows.** The core is a generic dispatcher (`delegate`); the specialized types
   (`audit`, `review`, `debug`, `execute_plan`, `research`, `investigate`) are
   thin, opinionated presets — rods — over the same primitives. The set grows as
   the lifecycle widens, but each rod stays a thin gate; we don't accumulate domain
   logic inside them.
3. **Cross-agent review is the quality mechanism.** Every task flows through a
   two-phase pipeline: implement on one agent, review on a *different* one. Review
   runs until approved, findings plateau, or the safety limit is hit. Callers may
   set `reviewPolicy: "none"` where a single pass genuinely suffices — but the
   default is always cross-agent. (This is the mechanism behind the global
   principle "Quality is structural.")
4. **Bounded execution.** Every task carries a cost ceiling and a wall-clock
   timeout; the system owns iterative loops *within* a call (supervision retries,
   review rework), the caller orchestrates *between* calls. No autonomous sessions,
   no runaway cost. (This is the mechanism behind the global principle "No autonomy
   theater.")
5. **We shouldn't make agents fail at tasks they can do.** If the work evidence is
   on disk, the status reflects it. Parallel tasks that share a filesystem get
   targeted test commands, not full-project builds. Platform failures are ours, not
   the model's.
6. **Every tool call is a self-contained unit.** Each request takes everything it
   needs, executes, and returns — no dependence on hidden server-side session
   state. Context is an explicit, caller-controlled store (`POST /context-blocks` →
   id → pass the id onward). Stateless requests, stateful caller.

## What this package does

- **The two-slot model.** Users configure two labor agents: `standard` (heavy
  implementation — file writes, test runs, mechanical work) and `complex` (advanced
  labor — review, audit, spec/security analysis). These are labor categories, not
  intelligence tiers; the user defines what each means for their budget. The
  engineer's own agent never enters a slot.
- **The reviewed two-phase pipeline** (implement → review), the structural default
  for every task type.
- **The rods, today:** `delegate` (the generic power tool) plus the specialized
  gates (`audit`, `review`, `debug`, `execute_plan`, `research`, `investigate`) and
  `retry_tasks`, with context managed via `POST /context-blocks`. The set is open
  and expected to grow.
- **Substantiating The Bet.** The engine's falsifiable claim: a reviewed
  multi-agent harness matches or beats a single frontier model at a fraction of the
  cost. A solo frontier run is one model, one pass, no independent check; the
  harness adds the right agent per task, an independent cross-agent review, and
  audit gates over the spec and plan — then routes routine work to lean tiers so
  the full harness stays affordable. Measured against a real main-equivalent
  baseline; if the bet stops holding for a task class, we say so and route it
  differently.
- **Structured reports:** status, worker self-assessment, spec + quality review
  verdicts, files changed, validations run, a cost breakdown with saved-cost ROI,
  and timing — plus a quotable headline.
- **Delivery:** `npm install -g @zhixuan92/multi-model-agent`; `mma serve` (a
  loopback daemon that survives client sessions); `mma sync-skills` (writes and
  reconciles skill files per detected client).

## What this package won't do

- **Won't maintain workflow state.** No implicit session, no conversation memory;
  the caller owns the workflow.
- **Won't accumulate domain logic in rods.** If a workflow can be composed from
  existing primitives, it doesn't become a rod parameter.
- **Won't optimize for a specific model.** A quirk gets fixed in the platform,
  never a per-model branch.
- **Won't chase autonomy.** Bounded execution with checkpoints — we run a task,
  review it, and return.

## Relationship to the other surfaces

- **Forge (team mode)** drives the engine from outside, over HTTP on loopback
  (`127.0.0.1:7337`), owning the SDLC chain and its gates. The engine never links
  Forge and knows nothing of teams, projects, or RBAC — the boundary is strictly
  HTTP.
- **Telemetry (proof surface)** consumes the usage and evidence the engine emits
  (per-stage cost, tier, findings) to prove the economics. The engine's job is to
  emit honest, per-stage-attributed data; how it is presented is the telemetry
  surface's concern.
- **The engineer's own agent** stays on architecture, design, and final decisions
  — it never enters the `standard`/`complex` slots.

## /direction mirror note

The public `/direction` page mirrors this document's sections under the `mma`
group. Keep them in sync via
`multi-model-agent-telemetry-frontend/docs/direction-parity-checklist.md`; an edit
here requires the mirrored page section to be updated in the same change.
