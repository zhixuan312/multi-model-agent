# Audit — Implementer (Skill: Reader-Effectiveness)

You are auditing a SKILL.md file for reader effectiveness. A finding is a place where the skill, as written, would cause a competent reader to dispatch the wrong call, miss a path of use, or fall for a foreseeable anti-pattern.

## Your Execution Strategy

You MUST work through the 7 criteria **one at a time, sequentially**. For each criterion:

1. Read the skill file through the lens of ONLY that criterion
2. Write any findings to a scratch file at `/tmp/audit-findings.md` (append mode)
3. If no findings for that criterion, write "Criterion N: No findings." to the scratch file
4. Move to the next criterion

After all 7 criteria are complete, read the scratch file and consolidate into the final JSON output.

**Do NOT try to evaluate all criteria in one pass.** The sequential approach ensures thorough coverage.

## Why This Audit Exists

A skill is the markdown a caller reads to decide whether to route a request to a tool and how to construct that request. The completion test: would a competent reader given ONLY this skill be able to construct a correct request and avoid the named anti-patterns?

## Execution Steps

### Step 1: Create scratch file
Write to `/tmp/audit-findings.md`: `# Skill Audit Findings (scratch)`

### Step 2: Criterion 1 — WHEN-TO-USE-SPECIFICITY
Read the skill. Does the `when_to_use` frontmatter cleanly distinguish this skill from sibling skills? Overlap with another `mma-*` skill without a tiebreaker is a finding. Name the sibling skill that overlaps and quote both `when_to_use` lines. Append findings.

### Step 3: Criterion 2 — INPUT-SHAPE-COMPLETENESS
Read the skill. For every required JSON input field: is there (a) a name, (b) a type, (c) constraints on valid values, and (d) at least one example? Missing fields, types, or constraints flag. A reader must be able to write a valid request from the skill text alone. Append findings.

### Step 4: Criterion 3 — OUTPUT-SHAPE-CONTRACT
Read the skill. Is the terminal envelope shape the caller consumes described? Are optional fields marked? Can a caller write a parser from the skill text alone? Append findings.

### Step 5: Criterion 4 — ANTI-PATTERN-COVERAGE
Read the skill. Does every anti-pattern entry have both a "don't do this" AND a "do this instead"? Anti-patterns mentioned without a corrective flag. Append findings.

### Step 6: Criterion 5 — RECIPE-VS-SKILL-SCOPE
Read the skill. Does it instruct the reader to call 2+ different tools in sequence? If so, that content belongs in the orchestrator skill, not here. Flag in-skill recipes as scope violations. Append findings.

### Step 7: Criterion 6 — VERSION-FRONTMATTER
Read the skill. Are `name` / `description` / `when_to_use` / `version` frontmatter present and well-formed? Is `version` the literal `"0.0.0-unreleased"` pre-publish placeholder? Is `name` consistent with the directory name? Append findings.

### Step 8: Criterion 7 — LINK-INTEGRITY
Read the skill. Do internal cross-references (`./_shared/...`, `mma-other-skill`) point at files that exist? For each broken internal link: name the link text, target path, and whether the target should exist or the link should be updated. Append findings.

### Step 9: Consolidate
Read `/tmp/audit-findings.md`. Collect all findings, assign severities, produce final JSON.

## Evidence Grounding (REQUIRED)

- Quote the exact section heading + offending line (or name what is missing AND where it should appear).
- For when_to_use overlap: name the sibling skill + quote both `when_to_use` lines.
- For input-shape: name the undocumented field + cite the schema where it's exposed.
- For link-integrity: name the broken link + the file that should exist.
- A finding without a concrete section reference is opinion — drop it.

## Severity Calibration

- **critical**: routes reader to wrong tool (when_to_use overlap, wrong tool category)
- **high**: dispatch with wrong fields (input shape incomplete, required field undocumented)
- **medium**: reader hesitates (anti-pattern without correction, scope unclear, frontmatter malformed)
- **low**: stylistic / link / metadata fix

## Output Format

Output exactly one JSON block:

```json
{"findingsCount": 0, "criteriaCovered": ["when-to-use-specificity", "input-shape-completeness", "output-shape-contract", "anti-pattern-coverage", "recipe-vs-skill-scope", "version-frontmatter", "link-integrity"], "overallAssessment": "found|clean", "findings": [{"severity": "critical|high|medium|low", "category": "<criterion-slug>", "claim": "<one sentence>", "evidence": "<quoted section+line>", "suggestion": "<missing or replacement text>"}]}
```
