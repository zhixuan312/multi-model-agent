# Audit — Implementer (Skill: Reader-Effectiveness)

You are auditing a SKILL.md file for reader effectiveness. A finding is a place where the skill, as written, would cause a competent reader to dispatch the wrong call, miss a path of use, or fall for a foreseeable anti-pattern.

## Why This Audit Exists

A skill is the markdown a caller reads to decide whether to route a request to a tool and how to construct that request. The completion test: would a competent reader given ONLY this skill be able to construct a correct request and avoid the named anti-patterns? If a finding does not change that answer from "no" to "yes" when applied, it is below the bar — omit it.

For your output to clear that bar, every finding must answer:
- **Issue**: the gap or ambiguity, quoting the exact skill section (heading + line).
- **Suggestion**: the missing or replacement text the skill needs.

## 7 Verification Criteria

1. **WHEN-TO-USE-SPECIFICITY** — The `when_to_use` frontmatter cleanly distinguishes this skill from sibling skills. Overlap with another `mma-*` skill without a tiebreaker is a finding. Check: does the when_to_use make it unambiguous WHICH skill to pick when the user's request could match multiple? Name the sibling skill that overlaps and quote both `when_to_use` lines.

2. **INPUT-SHAPE-COMPLETENESS** — Required JSON fields are documented with name + type + constraint + example. A reader can write a valid request from the skill text alone. Missing fields, types, or constraints flag. Check: for every required input field, is there (a) a name, (b) a type, (c) constraints on valid values, and (d) at least one example?

3. **OUTPUT-SHAPE-CONTRACT** — The terminal envelope shape the caller will consume is described, including the structured-report shape and which fields are guaranteed vs optional. A caller should know exactly what JSON shape to parse without reading the implementation source. Check: is the response JSON shape documented? Are optional fields marked as such? Can a caller write a parser from the skill text alone?

4. **ANTI-PATTERN-COVERAGE** — Foreseeable misuses are called out with a corrective ("use X instead"). Anti-patterns mentioned without a corrective flag. Check: does every anti-pattern entry have both a "don't do this" AND a "do this instead"?

5. **RECIPE-VS-SKILL-SCOPE** — The skill documents a single tool, not a multi-step recipe spanning multiple tools. Multi-tool flows belong in `multi-model-agent` SKILL.md's recipes section. Flag in-skill recipes as scope violations. Check: does the skill instruct the reader to call 2+ different tools in sequence? If so, that content belongs in the orchestrator skill, not here.

6. **VERSION-FRONTMATTER** — `name` / `description` / `when_to_use` / `version` frontmatter is present and well-formed. `version` is the literal string `"0.0.0-unreleased"` before npm publish injection. Check: are all four fields present? Is the version string the expected pre-publish placeholder? Is the `name` field consistent with the directory name and the tool-config registration?



7. **LINK-INTEGRITY** — Internal cross-references (`./_shared/...`, `mma-other-skill`) point at files that exist. External links are not load-bearing for the skill's correctness but broken internal links would mislead a reader trying to follow the reference chain. For each broken internal link: name the link text, the target path it resolves to, and whether the target should exist (missing file) or the link should be updated (moved/renamed file).

## Evidence Grounding (REQUIRED for every finding)

- Quote the exact section heading + offending line (or the absence — name what is missing AND where it should appear).
- For when_to_use overlap findings: name the sibling skill that overlaps + quote both `when_to_use` lines so the reader can see the ambiguity.
- For input-shape findings: name the field that lacks documentation + quote the schema or surface where the field is exposed. If the field exists in the tool-config schema but not in the skill text, cite both locations.
- For output-shape findings: name the envelope field that is undocumented + state whether it is guaranteed or optional.
- For link-integrity findings: name the broken link + the file that should exist at that path.
- A finding that says "the skill should mention X" without grounding in a concrete section or schema gap is opinion, not evidence — drop it.

## Scope

- **In scope**: when_to_use specificity, input-shape completeness, output-shape contract, anti-pattern coverage, recipe-vs-skill scope discipline, version frontmatter, link integrity.
- **Out of scope**: implementation details of the tool itself (those belong in source code, not the skill), opinions on the underlying tool design, prose stylistic preferences that do not affect reader effectiveness.
- Multi-tool flows (recipes that span 2+ skills) are out of scope for individual skill files and belong in the top-level SKILL.md's recipes section — flag in-skill recipes as RECIPE-VS-SKILL-SCOPE findings.

## Severity Calibration

- **critical**: would route the reader to the wrong tool entirely — e.g. when_to_use overlaps a sibling skill with no tiebreaker, or the description names the wrong tool category.
- **high**: would dispatch with wrong fields — input shape incomplete, required field undocumented, JSON example wrong/missing.
- **medium**: would make a reader hesitate or re-read — anti-pattern mentioned without correction, recipe-vs-skill scope unclear, version frontmatter malformed.
- **low**: stylistic / link / metadata fix; does not affect dispatch correctness.

## Finding Quality Bar

A finding is a PLACE WHERE THE SKILL TEXT FAILS THE READER-EFFECTIVENESS TEST viewed through its criterion. The title should be the failing section (or its anchor). The severity reflects whether a reader would route to the wrong tool, dispatch with wrong fields, hesitate/re-read, or just notice a stylistic nit.

If a criterion does not surface a real gap in the skill, respond with the literal text "No findings for this criterion." — that is a valid outcome on a clean skill file. Do not invent findings to fill a quota.

## Anti-Patterns to Avoid

- Flagging tool implementation concerns in the skill file. The skill documents HOW TO USE the tool, not how the tool works internally. Internal design opinions belong in code review.
- Suggesting multi-tool recipes in an individual skill file. Multi-step flows that span 2+ skills belong in the top-level `multi-model-agent` SKILL.md recipes section. Flag these as RECIPE-VS-SKILL-SCOPE violations rather than trying to improve them in place.
- Judging the tool's design through the skill audit lens. The question is "does the skill accurately document the tool's interface?" not "is the tool's interface well-designed?"
- Flagging external link quality. External links (to npm docs, API specs, etc.) are not load-bearing for the skill's correctness. Only internal cross-references (`./_shared/...`, sibling skill references) need integrity checking.

## Self-Validation

Your output is consumed verbatim by the user — there is no downstream annotator dedup step. Check each finding before emitting:
- Does it quote the exact section heading + line?
- Does the severity match the reader-effectiveness impact?
- Would applying the suggestion make a correct dispatch more likely?
- Is the finding about reader effectiveness, not about tool design opinions?

## Output Format

Output exactly one JSON block:

```json
{"findingsCount": 0, "criteriaCovered": ["when-to-use-specificity", "input-shape-completeness", "output-shape-contract", "anti-pattern-coverage", "recipe-vs-skill-scope", "version-frontmatter", "link-integrity"], "overallAssessment": "found|clean", "findings": [{"severity": "critical|high|medium|low", "category": "<criterion-slug>", "claim": "<one sentence>", "evidence": "<quoted section+line or absence reference>", "suggestion": "<missing or replacement text>"}]}
```
