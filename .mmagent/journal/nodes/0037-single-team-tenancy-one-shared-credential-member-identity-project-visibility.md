---
id: "0037"
title: Single-team tenancy — one shared agent credential, member identity for audit, project-level visibility
category: decision
status: adopted
tags: [forge, tenancy, decision, architecture, security, visibility, state]
date: 2026-06-08
links:
  - type: relates
    to: "0032"
  - type: relates
    to: "0027"
  - type: relates
    to: "0033"
  - type: parent
    to: "0026"
supersededBy: null
---

## Context

FORGE TENANCY (2026-06-08): a **single engineering team = one tenant**, with one
shared workspace of many repos and **ONE global agent credential**
(`team_settings`, shared by all members).

- **Members** log in with their **own identity** (`member` table) used **only
  for ownership / visibility / audit — NOT for credentials.** Cost is
  **team-pooled.**
- **Repos** are **team-public** with a **role tag**
  (`production | test | infra | design`) that acts as a **routing hint.**
- **Project** = the unit of work, with **visibility `private | public`** plus a
  **`project_repo` subset** (editable) selecting which repos it touches.
- **PRIVATE hides the work ARTIFACTS** (Q&A / drafts / plan / history) **NOT the
  code** — all repos stay team-readable.
- **Visibility is enforced in the data layer**; `action_log` records who did
  what.
- **No orgs, no multi-team, no RBAC.**

This sits on the persisted state model (0032) and the `repo` table from 0027,
adding the `team_settings`, `member`, `project_repo`, and `action_log` tables.

## Consequences

- The single shared agent credential lives in `team_settings`; member identity
  never carries credentials — it exists for ownership, visibility, and audit
  trails only. Billing/cost is pooled at the team level.
- Visibility is a Project property, and `private` scopes only artifacts, never
  code — so authorization checks distinguish artifact reads from code reads.
- Repo `role` (production/test/infra/design) is a routing hint, not an access
  boundary; all repos are team-readable.
- Extends the 0032 schema spine with tenancy tables and is the trust context for
  0033's per-repo write/execute authorization (which is still required beyond
  this team-level model — there is no RBAC here).
- Deliberately scoped: no orgs / multi-team / RBAC — do not build them speculatively.
