# Skill Writing Guidelines

How we write `mma-*` skills (and the `multi-model-agent` router skill) under `packages/server/src/skills/`. Distilled from [Anthropic's official skill-authoring guide](https://docs.claude.com/en/docs/agents-and-tools/agent-skills) and the [superpowers `writing-skills` meta-skill](https://github.com/obra/superpowers).

## Audience

Future Claude sessions invoking `mma-*` skills via Claude Code, Gemini CLI, Codex CLI, or Cursor. Each skill must answer two questions for the model loading it:

1. **Should I use this skill right now?** (answered by the `description` frontmatter)
2. **How do I use it correctly?** (answered by the body)

If we get (1) wrong, the skill is never invoked. If we get (2) wrong, the call shape is wrong and the worker rejects.

## The 9 rules

### 1. `description` = "Use when..." triggering conditions only

The `description` field is what Claude reads to decide whether to load the skill. It must answer "should I use this right now?", **NOT** "what does this skill do?".

**Why:** Testing by superpowers showed that descriptions which summarize the workflow cause Claude to *follow the description and skip the body*. A description saying "code review between tasks" caused Claude to do ONE review even though the skill body's flowchart called for two.

```yaml
# ✅ GOOD — triggering conditions, no workflow summary
description: Use when you need to answer a question about the codebase ("how does X work", "where is Y called") and reading + grepping the codebase yourself would consume main-context tokens

# ❌ BAD — workflow summary; Claude shortcuts and never reads the body
description: Investigates the codebase by reading files and emitting a structured report with citations and confidence
```

Required form:
- Start with **"Use when..."** or **"Use first when..."**
- Include **concrete triggers** (specific user phrases, file paths, error messages, symptoms)
- Third person, ≤500 chars
- Never describe the skill's *process*

### 2. Length budget by role

| Role | Body length |
|---|---|
| API-reference skill (one endpoint, mechanical call shape) | ≤200 lines |
| Process / discipline skill (decision flowcharts, anti-patterns, real-world impact) | ≤500 lines |
| Frequently-loaded router skill | ≤200 words *of prose* (table content + code examples don't count) |

Anthropic's hard ceiling: **500 lines** for SKILL.md body before progressive disclosure becomes mandatory. Word-count is the truer metric — count words of prose, not table cells.

**Why:** every token loaded shares the context window with conversation history. Concision is courtesy.

### 3. Use both positive instruction AND ❌ / ✅ pairs

Negative examples anchor the rule. They show Claude *exactly* the failure mode to avoid, then *exactly* what right looks like.

```markdown
**Use `filePaths` to anchor narrow questions:**

❌ `{ "question": "Where is parseConfig called?" }` — searches the whole repo
✅ `{ "question": "Where is parseConfig called?", "filePaths": ["src/"] }` — bounded
```

The "positive language only" rule (banning ❌) is wrong — both Anthropic and superpowers use Bad/Good pairs in *every* major section because they teach faster than positive prescriptions alone.

### 4. Every rule has a 1-sentence "why"

If a rule's rationale isn't obvious, write it. One sentence. Not a paragraph.

```markdown
✅ Set `agentType: "complex"` when the task touches many files. **Why:** the standard-tier model can't hold enough context across files to keep the edits coherent.

❌ Set `agentType: "complex"` when the task touches many files.
```

### 5. Concrete triggers, not abstract symptoms

Replace "when debugging" with "when 3+ test files fail with different root causes". Replace "for large tasks" with "when the worker returned `filesWritten: 0` or hit `incompleteReason: turn_cap`".

**Why:** Claude searches for matches against its current situation. Abstract triggers don't match.

### 6. Progressive disclosure for heavy reference

Split heavy reference (large request schemas, error tables, polling code) into separate `_shared/*.md` files inside the skill directory. Reference them with `@include _shared/<file>.md`.

```markdown
@include _shared/auth.md
@include _shared/polling.md
@include _shared/response-shape.md
```

**Why:** SKILL.md should fit in one screen of attention. Heavy reference is loaded only when needed, and shared snippets stay in sync across skills.

**Constraint:** one level deep. SKILL.md → `_shared/x.md` ✅. SKILL.md → `_shared/x.md` → `_shared/y.md` ❌ — Claude may partial-read nested references and miss content.

### 7. Match degrees of freedom to task fragility

| Fragility | Style | Example |
|---|---|---|
| **High freedom** (many valid approaches) | Text instructions, heuristics | "Pick `agentType: complex` when the task is ambiguous, security-sensitive, or touches many files" |
| **Medium freedom** (preferred pattern) | Pseudocode + parameters | "`reviewPolicy: 'diff_only'` for mechanical refactors; default `'full'` otherwise" |
| **Low freedom** (fragile sequence) | Exact script, no flexibility | "Run exactly: `mmagent serve >/dev/null 2>&1 & disown`" |

**Why:** over-specifying robust tasks wastes tokens; under-specifying fragile tasks causes silent breakage.

### 8. Consistent terminology

Pick one term per concept and use it everywhere. Common pairs we mix and shouldn't:

| Pick this | Don't also use |
|---|---|
| `task descriptor` | `task heading`, `task name`, `task ID` |
| `worker` | `sub-agent`, `agent`, `delegated agent` |
| `terminal envelope` | `final response`, `result body` |
| `batchId` (camelCase, JSONL keys) | `batch_id`, `batch-id` |
| `batch` (CLI / stderr short form) | `batchId` (in stderr context) |

**Why:** Claude's pattern-matching depends on stable vocabulary; synonym soup defeats grep and lookup.

### 9. Cross-reference other skills with `REQUIRED SUB-SKILL:` markers

Reference by skill name, never with `@` paths.

```markdown
✅ If the batch reaches `awaiting_clarification`, use `mma-clarifications` to confirm the proposed interpretation.

✅ **REQUIRED SUB-SKILL:** Use `mma-context-blocks` to register the spec once before fanning out N tasks that all reference it.

❌ See @packages/server/src/skills/mma-clarifications/SKILL.md for the resume flow.
```

**Why:** `@` syntax force-loads the file immediately, burning context before the model even decides it's needed. Skill-name references let Claude lazy-load.

## Required SKILL.md structure

```markdown
---
name: skill-name
description: Use when [triggering conditions]
when_to_use: [Same triggering conditions, fuller form — fed to skill router]
version: "0.0.0-unreleased"
---

# Skill Name (H1 — title-cased, matches the package name)

## Overview

1–2 sentences answering "what does this do". Then **Core principle:** in one sentence — the load-bearing idea behind the skill.

## When to Use

[Optional decision flowchart in `dot`/graphviz IF the choice between this skill and an alternative is non-obvious.]

**Use when:** bullet list of concrete triggers.

**Don't use when:** bullet list of close-but-wrong triggers, with the right alternative.

## Endpoint

`POST /<route>?cwd=<abs-path>`

@include _shared/auth.md

## Request body

JSON example + field table.

## Full example

curl one-liner that's actually copy-pasteable.

@include _shared/polling.md

@include _shared/response-shape.md

## Common pitfalls (process skills) OR Per-task report shape (API skills)

❌ / ✅ pairs for the failure modes we've actually seen in practice.

@include _shared/error-handling.md
```

## Frontmatter contract (test-enforced)

`tests/contract/skills/skill-frontmatter.test.ts` and `tests/skills/skill-validity.test.ts` check:

| Field | Constraint |
|---|---|
| `name` | matches directory name |
| `description` | ≥20 chars; should start with "Use when" (lint warning, not hard fail) |
| `when_to_use` | ≥20 chars |
| `version` | `"0.0.0-unreleased"` in source; build-injected to package version in `dist/` |
| Body length | ≤200 lines |
| `@include _shared/*.md` | every reference must resolve |
| First endpoint backtick line | matches a real route in `tests/contract/goldens/routes.json` |

## When to violate these guidelines

The 9 rules cover ~95% of cases. When you have a real reason to deviate:
- Document it in the skill body (1 sentence) so the next reader sees the intent
- Confirm the contract test still passes
- Don't break the frontmatter shape — that's the load-bearing surface for skill discovery
