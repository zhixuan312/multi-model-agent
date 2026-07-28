---
name: mma-breakout
description: "Claude Code command: /mma-breakout — spawn a named expert breakout teammate, keep the deep dialogue isolated, and close with one confirmed journal batch"
when_to_use: "User explicitly invokes /mma-breakout. This is a Claude Code command, not an auto-matched skill."
version: "0.0.0-unreleased"
---

# /mma-breakout

A Claude Code command (the user types `/mma-breakout`) for spinning up one bounded,
interactive expert-persona breakout inside the current Claude Code session. It is
Claude Code only, client-side only, and intentionally thin: the command defines the
conversation contract, the breakout lifecycle, and the journaling close-out rules. It
does **not** add a server schema, task type, HTTP route, backend orchestrator, or any
change to `journal_record`.

## Required intake

Collect these inputs before spawning the teammate:

- `role` — the expert persona the operator wants to consult.
- `topic` — the breakout subject that will also be reused for journaling.

Optional overrides:

- `model`
- `tool profile`
- `topic slug`

Default any omitted overrides to:

- `model: sonnet`
- `tool profile: read-only repository access`

Do not start the breakout until `role` and `topic` are both present.

## Spawn contract

Spawn exactly one named background teammate through the Claude Code harness `Agent`
tool using `run_in_background: true`.

The spawn call must include:

- `name`
- `subagent_type`
- `model`
- `prompt`
- `run_in_background: true`

The prompt must tell the teammate all of the following:

- it is the breakout expert for the requested `role`;
- the breakout subject is the requested `topic`;
- the user will converse with it directly through `@name`;
- it must keep its own notes inside teammate context and must not ask the main agent
  to replay the breakout transcript;
- if asked to close out, it must distill the entire breakout into journal-ready
  insights shaped as `{ learning, type }`, where `type` is one of `decision`,
  `design`, `behavior`, `process`, `knowledge`, or `style`.

## Conversation path

After spawn, direct the operator to converse with the teammate through direct
`@name` addressing. The main agent should stay out of the content path unless the
harness requires an explicit relay action for delivery.

Relay hygiene rules:

- suppress contentless idle pings;
- surface only substantive teammate content;
- do not treat ordinary silence or relay gaps as failure;
- do not use the main agent's partial relay view as the source of truth about what
  the breakout discussed.

## Close-out contract

When the user signals that the breakout is complete:

1. Ask the teammate to distill the entire breakout from the teammate's own
   authoritative context into a journal-ready list of insights.
2. Require each insight item to contain:
   - `learning`
   - `type` from `decision | design | behavior | process | knowledge | style`
3. Show that distilled list to the user before any recording occurs.
4. Let the user review, remove, reorder, edit, or approve items.
5. After approval, dispatch exactly one `journal_record` task with the full confirmed
   batch and one shared `topic` value.
6. After the `journal_record` dispatch completes, dismiss the teammate with
   `TaskStop`.

## Guardrails

- No server schema, task type, or HTTP route is added — `/mma-breakout` is client-side only.
- This command is for Claude Code only and is not an auto-matched skill.
- Never read the teammate's raw `.output` transcript back into main context.
- Durable insights may arrive only through surfaced teammate messages and the
  teammate's close-out summary.
- The main agent must not reject an insight solely because it did not witness the
  supporting exchange in its own relay view.
- Distinguish main-agent desync from genuine context corruption.
- Only if the teammate shows genuine context corruption should the flow `TaskStop`
  that teammate and respawn a fresh one.
- Main-agent lack of visibility into direct `@name` turns is not proof of corruption.
- Never auto-record journal entries without human confirmation.
- Do not widen the default tool profile beyond read-only repository access unless the
  user explicitly overrides it.
