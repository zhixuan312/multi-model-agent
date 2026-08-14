# Runnable prototype — Delivery packager guidance

**Delivery Contract:** `runnable-prototype@1`
**Target type:** `runnable-prototype`
**Requires:** `executable_prototype`, `sample_data`, `usage_instructions`, `known_limitations`, `acceptance_evidence`
**Verification:** `starts_locally`, `sample_flow_passed`, `business_user_reviewed`

This asset is packager guidance, not target guidance. It tells you how to assemble a
`runnable-prototype@1` Deliverable's bundle and how to check that bundle against this Delivery
Contract's `requires` and `verification` lists before it is registered as valid. It does not
configure, contact, deploy to, or hand off to any target environment — that behavior belongs
entirely to a registered `TargetAdapter`, never to this document or to core.

## Assembling the bundle

Attach one Artifact per `requires` entry (`deliverable_attach_artifact`, one call per
requirement) before asking for validation. Each Artifact must actually satisfy the requirement
it is attached under — attaching an unrelated file under a requirement name does not satisfy it,
even though the store only checks requirement-key membership, not content.

- **`executable_prototype`** — the runnable artifact itself: a script, a small app, a notebook,
  or an equivalent runnable unit that a reviewer can start without reading source code first.
  Register it with `storage_mode: 'managed'` when the content is small enough to store directly,
  or `storage_mode: 'reference'` with a durable path/URI when it is not (e.g. a built container
  image or a large dataset directory). Confirm the reference actually resolves before attaching
  it — a dangling reference is not a satisfied requirement.
- **`sample_data`** — the smallest data set that exercises the prototype's primary flow. Prefer
  synthetic or already-public data; never attach production or customer data. If the prototype
  needs no data to run, attach a short note artifact saying so explicitly rather than omitting
  the requirement.
- **`usage_instructions`** — plain, sequential steps a reviewer with no prior context can follow
  to start the prototype and exercise its primary flow: prerequisites, the exact start command
  or entry point, and what a successful run looks like.
- **`known_limitations`** — an honest list of what the prototype does not yet do, known rough
  edges, and anything a reviewer might mistake for a defect but is actually expected. A prototype
  with no known limitations should say so explicitly, not omit the artifact.
- **`acceptance_evidence`** — the record that the prototype was actually run and observed working
  (a transcript, a screen recording reference, a log excerpt, or a written observation), not a
  restatement of the usage instructions. This requirement exists specifically so validation does
  not rest on the packager's own unverified claim.

## Checking the bundle before it is valid

Before treating the Deliverable as ready, walk each `verification` entry and confirm it is true
of the bundle you assembled, not merely asserted:

- **`starts_locally`** — following exactly the steps in `usage_instructions`, the
  `executable_prototype` artifact starts without an undocumented prerequisite or missing
  credential. If starting it required a step the instructions do not mention, the instructions
  are incomplete — fix the artifact, do not silently rely on tribal knowledge.
- **`sample_flow_passed`** — using `sample_data`, the prototype's primary flow completes and
  produces the outcome the `acceptance_evidence` artifact records. If the sample data cannot
  drive the primary flow to completion, the bundle is not ready regardless of what the other
  artifacts say.
- **`business_user_reviewed`** — a person outside the implementing team looked at the running
  prototype (using `usage_instructions` and `sample_data`) and confirmed it does what was asked.
  This is a human review step, not a check a packager can satisfy by itself; do not mark it
  satisfied without recording who reviewed it.

## What this document is not

This guidance stops at "the bundle is complete and internally verified." It never names a
deployment target, a hosting environment, a delivery channel, a handoff recipient, or any
target-specific command — deciding whether and how to actually deliver a validated bundle to a
real target is exclusively a `TargetAdapter`'s `validate` behavior, registered through the public
adapter registry, never logic embedded in this asset or in core.
