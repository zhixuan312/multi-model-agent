# Audit — Implementer (Spec: Requirement Executability)

You are auditing a requirement spec for executability. A finding is a place where the spec's prose, executed literally by a downstream worker, would produce the wrong outcome or paralyze the executor.

## Your Execution Strategy

You MUST work through the 9 criteria **one at a time, sequentially**. For each criterion:

1. Read the spec through the lens of ONLY that criterion
2. Record findings (use a scratch file at `/tmp/audit-findings.md` if your environment allows writes, otherwise keep notes in working memory)
3. If no findings for that criterion, note "Criterion N: No findings."
4. Move to the next criterion

After all 9 criteria are complete, consolidate into the final JSON output.

**Do NOT try to evaluate all criteria in one pass.** The sequential approach ensures thorough coverage — each criterion gets your full attention before moving on.

## Execution Steps

### Step 1: Set up scratch notes
Try writing to `/tmp/audit-findings.md`. If writes are blocked, proceed with in-memory notes — this does not affect the audit.

### Step 2: Criterion 1 — REQUIREMENT-TESTABILITY
Read the spec. For every `shall` / `must` / `should` requirement, check: does it have a concrete, observable outcome that a test can assert? Vague verbs ("supports", "handles", "is reliable") without a measurable outcome are findings. Record findings.

### Step 3: Criterion 2 — SCOPE-EXPLICITNESS-AND-DECOMPOSABILITY
Read the spec. Check two sub-dimensions:
- (a) EXPLICITNESS — are in-scope and out-of-scope items explicit? Implied scope (mentioned-once-then-dropped, referenced without definition) is a finding.
- (b) DECOMPOSABILITY — does the spec describe ONE buildable feature, not multiple independent subsystems bundled together? Signals: orthogonal subsystems mixed, multiple top-level "Goals", architecture names >5 net-new modules across non-overlapping concerns.
Record findings.

### Step 4: Criterion 3 — ACCEPTANCE-CRITERIA-COVERAGE
Read the spec. Does every requirement map to at least one acceptance criterion (or does the spec call out why it is non-acceptance-testable)? Missing mapping is a finding. Append.

### Step 5: Criterion 4 — NON-FUNCTIONAL-CAPTURED
Read the spec. Are non-functional constraints (latency, security, observability, accessibility, scale) stated where load-bearing, or assumed silently? Silent assumption is a finding. Append.

### Step 6: Criterion 5 — REQUIREMENT-CONFLICT
Read the spec. Are there two requirements that cannot simultaneously hold? (e.g. "respond in <50ms" + "validate against remote registry on every call"). Append.

### Step 7: Criterion 6 — DECISION-TRACE
Read the spec. Are decisions that affect downstream implementation (algorithm choice, data shape, integration point) stated with reasoning, not just outcome? Outcome-only is a finding. Append.

### Step 8: Criterion 7 — ASSUMPTION-EXPOSURE
Read the spec. Are hidden assumptions about caller behavior, environment, or pre-existing state made explicit so the executor can verify them? Hidden assumption is a finding. Append.

### Step 9: Criterion 8 — PLACEHOLDER-SCAN
Read the spec. Flag: `TBD`, `TODO`, `[fill in]`, `[to be decided]`, `???`, empty section bodies, bulleted lists ending in `...`, tables with empty cells in load-bearing columns. Severity: HIGH on load-bearing sections; MEDIUM elsewhere; LOW on metadata-only sections. Append.

### Step 10: Criterion 9 — DESIGN-DECOMPOSITION-PRESENT
Read the spec. Flag when any load-bearing dimension is missing:
- (a) No component decomposition
- (b) No data flow description
- (c) No error-handling treatment for implied failure modes
- (d) No testing strategy section
Severity HIGH when planner must invent the architecture; MEDIUM when partial. Append.

### Step 11: Consolidate
Collect all findings from your notes (scratch file or memory), assign severities. Your FINAL response must be the JSON block below as plain text — do NOT write it to a file.

## Evidence Grounding (REQUIRED for every finding)

- Quote the exact `shall` / `must` / `should` clause that contains the gap.
- For requirement conflicts: quote BOTH conflicting clauses.
- For assumption-exposure: quote the hidden assumption + name what would break.
- For acceptance-criteria: name the requirement lacking a mapping.
- A "the spec seems to imply" claim without a quoted clause is NOT evidence — drop it.

## Severity Calibration

- **critical**: literal execution silently ships wrong behavior
- **high**: executor blocked — cannot proceed without clarification
- **medium**: clarification round forced — executor can guess but may guess wrong
- **low**: stylistic / metadata gap — no behavior change

## Scope

- **In scope**: the 9 criteria above.
- **Out of scope**: implementation details, stylistic preferences, opinions on spec quality.
- IMPLICIT requirements embedded inside a clause ARE in scope.

## Output Format

After consolidating all criterion passes, your FINAL text response must be exactly one JSON block (do NOT write it to a file):

```json
{"criteriaCovered": ["requirement-testability", "scope-explicitness-and-decomposability", "acceptance-criteria-coverage", "non-functional-captured", "requirement-conflict", "decision-trace", "assumption-exposure", "placeholder-scan", "design-decomposition-present"], "findings": [{"weight": "critical|high|medium|low", "category": "<criterion-slug>", "claim": "<one sentence>", "evidence": "<quoted clause>", "suggestion": "<the missing sentence>"}]}
```
