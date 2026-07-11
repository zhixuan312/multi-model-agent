# multi-model-agent — Product Direction

multi-model-agent (MMA) helps engineers adopt the **full AI software development
lifecycle** — as an individual or as a team — and proves the work was worth it.
One engine routes the right agent to the right task and enforces quality through
cross-agent review. Two adoption modes sit on that engine: the **engine directly**
for the individual, **Forge** for the team. One **proof surface** shows the
economics, honestly. Models go deep; we connect them wide — and the engineer
always keeps the judgment.

## The Insight

Models are going deep. We connect them wide. Every provider is racing to make one
model better at everything — reasoning, coding, tool use, long context — and they
should. But no single model is the right tool for every task, and no single model
is a *workflow*. The value is in the horizontal layer that connects models to a
lifecycle: routing the right task to the right agent, enforcing quality through
cross-agent review, controlling cost through bounded execution, and proving it.
The providers go deeper; we connect them wider — and we wrap the whole thing in a
lifecycle an individual or a team can actually adopt.

## The Aim

Help every user — the individual power-user and the product team alike — adopt the
**full AI SDLC**, and assist product teams in their delivery work. The lifecycle
(investigate / research → spec → plan → execute → review → debug, with audit
gating the spec and the plan) is not a feature bolted on; it is the thing we help
people adopt, instrument, and trust. Whether one engineer wields it directly or a
team runs it through a gated workflow, the aim is the same: more of the delivery
lifecycle, done with a routed, reviewed, evidenced harness.

## One Engine, Two Modes

There is one engine and two ways to adopt it:

- **The engine, directly — the individual mode.** The npm package plus installable
  skills, called from whatever agent client the engineer already uses. Flexible,
  unopinionated about workflow, deployed however they like. The power-user path:
  maximum control, minimum ceremony.
- **Forge — the team mode.** A collaborative orchestration app built on the engine
  (over HTTP), giving a team a standardized, gated SDLC workflow with roles,
  review gates, and shared knowledge. The path for a product team that wants the
  lifecycle consistent across people, not reinvented per engineer.

Same engine underneath. The mode is a choice about how much structure the user
wants — not a different product.

## The Surface Map

Three surfaces, one product:

- **mma engine** executes each stateless per-stage rod and returns evidence. It is
  the labor layer. → `mma/GUIDELINES.md`.
- **mma-forge** owns the SDLC chain and its gates, driving the engine from outside
  over HTTP. It is the team workflow. → `mma-forge/GUIDELINES.md`.
- **telemetry** aggregates usage from *both* the engine and Forge and presents the
  economic proof. It is the evidence surface. → `telemetry/GUIDELINES.md`.

This document is the global north star above all three; each surface's own
guidelines carry its product-specific direction.

## The Bet

A reviewed multi-agent harness delivers quality as good as — or better than — a
single frontier model running alone, at a fraction of the cost, and we **measure**
it. That is a promise we hold ourselves to and prove with honest evidence, not a
slogan. The specific falsifiable claim, and how the engine substantiates it, live
in `mma/GUIDELINES.md`; the commitment to prove it — and never to dress it up — is
global.

## Global Principles

These govern every surface. Surface-specific mechanisms live in each package's
guidelines.

1. **We help, we don't replace.** The engineer does judgment; we do labor and
   gating. We never decide what to build, which approach to take, or whether to
   merge. The engineer's judgment is input; our output is evidence.
2. **Quality is structural, not aspirational.** Quality comes from structure —
   independent checks, not a model grading its own work: a *different* agent
   reviews the engine's output, human gates review Forge's, and the proof surface
   measures independently. (The engine's two-phase review mechanism is detailed in
   `mma/GUIDELINES.md`.) Findings are advisory signal for the engineer, never
   inflated into failure.
3. **Evidence and economics are first-class — and honest.** We prove the work was
   worth it: real savings against a real baseline, issues caught, routing
   transparency — reported so it is defensible to anyone, not just the owner.
   Unknown is never dressed up as zero, and if a number would mislead, we don't
   show it.
4. **No autonomy theater.** Work runs in bounded units with checkpoints, not
   hours-long autonomous sessions — the engineer decides what happens next. Even
   Forge's automated mode gates the design phases and keeps a human on the merge.
   (The engine's cost-ceiling / wall-clock mechanism is detailed in
   `mma/GUIDELINES.md`.)
5. **The platform is the product; models are configuration.** We optimize the
   system around models, never a model-specific branch — and the whole product
   stays provider-neutral: the engine routes any model, Forge orchestrates any
   model, and the proof surface reports across families without favor.
6. **We harness the lifecycle; we don't author it.** We instrument and gate each
   stage — evaluation, review, audit — but the engineer makes every call: what to
   build, which approach, whether to advance. We are the rails and the gates,
   never the driver.

## Where We're Going

- **Perfect the protocol** — the engine should feel as built-in as the client's
  own tools.
- **Widen the lifecycle** — more rods, more gates, more stages, for both modes.
- **Make the economics undeniable** — deepen the proof surface, public where it
  builds trust and defensible to anyone.
- **Both modes mature** — the individual gets more power with less ceremony; the
  team gets a more complete, more standardized workflow.

The reviewed multi-agent harness becomes the unit of AI software engineering. The
question shifts from "which model should I use?" to "how is my harness configured,
and how wide is its lifecycle coverage?"

## What We Won't Do

- **No model-specific hacks.** A quirk gets fixed in the platform, not a per-model
  branch.
- **No decisions for the engineer.** We execute, review, audit, and report.
- **No hidden workflow state we own.** The caller — or Forge — owns the workflow;
  the engine owns individual task execution. Stateless requests, stateful caller.
- **No autonomy theater.** Bounded execution with checkpoints, not hours-long runs.
- **No dressed-up numbers.** Real savings against a real baseline; advisory
  findings shown as advisory. A north star built on a flattering chart is not a
  north star.
- **We won't compete with models.** When a model gets better at self-review, our
  independent check still adds value — different training, different blind spots.
  But if a single model genuinely becomes sufficient for a task class, we make
  routing it to one agent with review off easy. We adapt to what models can do,
  not to what we wish they couldn't.

## The Surface Guidelines

- `mma/GUIDELINES.md` — the engine (individual mode): right-agent routing, the
  rods, the two-slot `standard`/`complex` model, the reviewed two-phase pipeline,
  stateless self-contained requests, and the public-npm delivery model.
- `mma-forge/GUIDELINES.md` — Forge (team mode): the gated SDLC spine, automation
  gating, team tenancy + RBAC, PR-for-review.
- `telemetry/GUIDELINES.md` — the proof surface: the shared evidence model,
  honest-null discipline, and the public-aggregate / gated-detail posture.

---

*This document is the global north star. Each surface's guidelines refine it for
that product. Proposals cite it; design debates reference it. If a global
principle needs updating, update it here — not in a proposal footnote.*
