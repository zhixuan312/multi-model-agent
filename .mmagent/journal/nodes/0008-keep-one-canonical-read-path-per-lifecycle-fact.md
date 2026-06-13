---
id: "0008"
title: "Keep one canonical read path per lifecycle fact"
category: "design"
status: "adopted"
tags:
  - lifecycle
  - commit-gate
  - review-gate
  - single-source-of-truth
  - state-mirrors
date: "2026-05-24"
links:
  - type: "relates"
    target: "0001"
  - type: "relates"
    target: "0002"
supersededBy: null
---

## Context
In v4.7.14, the lifecycle state had accumulated convenience mirrors of authoritative gate data: `state.commits[]` alongside the commit gate payload, plus hoisted `state.reviewVerdict` and `state.reviewFindings` alongside the review gate payload. Those mirrors drifted from the real source of truth and caused concrete bugs. Rework did not fire because the mirrored review verdict was never promoted to match the authoritative review gate result, and the annotator read the unmaintained `commits[]` mirror and missed the worker's real commit SHA.

The correction was to retire the mirrors and read the canonical gate payloads directly everywhere: commit truth comes from `state.gates.commit.payload.kind`, and review truth comes from `reviewPayload(state).verdict` rather than any hoisted copy. The durable lesson is that a convenience mirror of authoritative state is an inconsistency bug waiting to happen once one writer stops updating it.

## Consequences
Each lifecycle fact must have exactly one canonical read path. If callers need ergonomic access, expose a single accessor over the authoritative source rather than copying the data into parallel state.

Future lifecycle changes should treat mirrored arrays, hoisted verdict fields, cached findings, and similar duplicate state as structural risk. Delete the copy instead of teaching more code to keep it synchronized.

When review, commit, or annotate behavior disagrees with expectations, first inspect whether any consumer is reading a stale mirror instead of the gate payload. If so, route that read back through the canonical accessor and remove the duplicate field.
