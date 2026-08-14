# Runnable software — Delivery packager guidance

**Delivery Contract:** `runnable-software@1`
**Target type:** `runnable-software`
**Requires:** `source_changes`, `run_instructions`, `successful_build`, `automated_checks`, `runnable_preview`
**Verification:** `build_passed`, `tests_passed`, `primary_user_flow_passed`

This asset is packager guidance, not target guidance. It tells you how to assemble a
`runnable-software@1` Deliverable's bundle and how to check that bundle against this Delivery
Contract's `requires` and `verification` lists before it is registered as valid. It does not
configure, contact, deploy to, or hand off to any target environment — that behavior belongs
entirely to a registered `TargetAdapter`, never to this document or to core.

## Assembling the bundle

Attach one Artifact per `requires` entry (`deliverable_attach_artifact`, one call per
requirement) before asking for validation. Each Artifact must actually satisfy the requirement
it is attached under — attaching an unrelated file under a requirement name does not satisfy it,
even though the store only checks requirement-key membership, not content.

- **`source_changes`** — the actual changed source, referenced by a durable pointer (a commit
  range, a diff, or a branch reference) rather than pasted inline. Register it with
  `storage_mode: 'reference'` pointing at that durable location; the bundle should never embed a
  full copy of a repository.
- **`run_instructions`** — plain, sequential steps to build and run the software from the
  `source_changes` reference: prerequisites, the exact build command, the exact run command, and
  what a successful run looks like. Do not assume the reader already has the environment
  configured — name every prerequisite.
- **`successful_build`** — the record that the build command in `run_instructions` actually
  completed without error against `source_changes` (a build log excerpt, a CI run reference, or
  an equivalent artifact), not a restatement that "the build should pass."
- **`automated_checks`** — the record that the project's automated test suite was actually run
  against `source_changes` and its result (a test run log, a CI run reference, or an equivalent
  artifact naming pass/fail counts). A missing or stale test-run record does not satisfy this
  requirement even if the suite is known to normally pass.
- **`runnable_preview`** — a way for a reviewer to exercise the running software's primary user
  flow directly, following `run_instructions` (a local run, a preview deployment reference, or an
  equivalent reachable instance). If no preview exists yet, attach a note artifact naming exactly
  how a reviewer can stand one up from `run_instructions` — never omit the requirement.

## Checking the bundle before it is valid

Before treating the Deliverable as ready, walk each `verification` entry and confirm it is true
of the bundle you assembled, not merely asserted:

- **`build_passed`** — following exactly the build command in `run_instructions` against
  `source_changes`, the build completes cleanly, matching what `successful_build` records. If
  reproducing the build surfaces an error the recorded artifact does not mention, the bundle is
  not ready — fix the artifact or the build, do not paper over the mismatch.
- **`tests_passed`** — the automated test run recorded in `automated_checks` reports a pass for
  the same `source_changes` this bundle references, with no unexplained failure or skip. A test
  run against a different revision than the one being delivered does not satisfy this entry.
- **`primary_user_flow_passed`** — using `runnable_preview` and `run_instructions`, the
  software's primary user flow completes end to end and produces the outcome a reviewer would
  expect. This is an exercised-and-observed check, not an inference from a passing test suite —
  record who exercised it and what they observed before marking it satisfied.

## What this document is not

This guidance stops at "the bundle is complete and internally verified." It never names a
deployment target, a hosting environment, a delivery channel, a handoff recipient, or any
target-specific command — deciding whether and how to actually deliver a validated bundle to a
real target is exclusively a `TargetAdapter`'s `validate` behavior, registered through the public
adapter registry, never logic embedded in this asset or in core.
