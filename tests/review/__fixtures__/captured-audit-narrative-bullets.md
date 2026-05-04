Now I have all the context needed. Let me compile the audit findings.

---

# Audit Report: v4.0.0 Goal & Vision Spec (`goal.md`)

**Audited file:** `docs/superpowers/specs/0.4.0/goal.md`
**Companion docs reviewed:** `horizontal_design.md`, `vertical_design.md`, `enums.md`, `architecture.md`, `overall.md`
**Date:** 2026-05-04

---

## Finding 1: PII detection mechanism unspecified for "removed never hashed/stubbed" guarantee

- Severity: high

- Location: goal.md (Two-layer scrubbing (C7) bullet under architectural hallmarks)

- Issue: The spec declares that "PII fields are **removed** (never hashed/stubbed)" on the telemetry path, which is a strong data-sanitization guarantee. However, neither `goal.md` nor the companion `horizontal_design.md` (C7) specifies how PII fields are detected or classified. Without a concrete PII detection mechanism (regex patterns, ML classifier, field-name allowlist), the implementation may silently fail to identify PII in free-form text like tool outputs, model responses, or user prompts — undermining the entire privacy guarantee. The `SecretRedactor` (C3) handles credential-like secrets (API keys, tokens), but PII (emails, names, phone numbers, IPs, physical addresses) is a distinct category that needs its own detection strategy.

- Suggestion: Add a PII detection strategy to the C7 `PrivacyFilter` block contract specifying at minimum: field-name-based allowlist for structured fields, regex-based detection for free-text fields, and a documented list of PII categories the filter must catch.

---

## Finding 2: 500-LOC ceiling enforcement is contradictory across spec documents

- Severity: medium

- Location: goal.md (What v4.0 delivers, item 4) vs architecture.md (Maintainability invariants section)

- Issue: `goal.md` states "A 500-LOC ceiling, **enforced** — natural consequence of one-block-per-concern. No special cases." (emphasis mine). However, `architecture.md` explicitly contradicts this: "v4.0 won't enforce the cap with a CI check; it bakes the discipline into the structure so the cap is hit naturally" and later "The 500 LOC ceiling isn't a hard rule — it's an emergent property." The two documents disagree on whether the ceiling is mechanically enforced or aspirational. This ambiguity will cause confusion during implementation — developers need to know whether a CI gate will reject a 510-line file.

- Suggestion: Align both documents to the same rule. Since `architecture.md` is more complete, update `goal.md` item 4 to say "A 500-LOC ceiling, structurally encouraged" and drop "enforced" and "No special cases."

---

## Finding 3: Unresolved C8/C9/C11 cross-references leave goal.md unreadable standalone

- Severity: medium

- Location: goal.md (v4.0 architectural hallmarks section)

- Issue: The architectural hallmarks section references "C11," "C9," and "C8" (e.g., "ReviewerEngine vs AnnotatorEngine split (C11)," "Per-category attempt budgets (C9)," "Two-layer scrubbing (C7)") without defining these labels. The labels are block/sub-group identifiers from `horizontal_design.md` and have no meaning to a reader of `goal.md` alone. A product stakeholder, new team member, or external reviewer reading `goal.md` as the entry-point document cannot resolve these references without opening a separate 89KB file and manually locating the matching section.

- Suggestion: Either spell out each reference inline (e.g., "ReviewerEngine vs AnnotatorEngine split (see C11 in horizontal_design.md)") or add a one-line parenthetical: "C11 = Review & Annotation module."

---

## Finding 4: Directory version (0.4.0) does not match document version (v4.0.0/v4.0)

- Severity: low

- Location: goal.md header + directory path `docs/superpowers/specs/0.4.0/goal.md`

- Issue: The spec directory is named `0.4.0` but the document title is `# v4.0.0 — Goal & Vision` and the body uses both `v4.0.0` and `v4.0` interchangeably. This is confusing: `0.4.0` implies a pre-1.0 semver (minor bump), whereas `v4.0.0` implies a major version. If `0.4.0` is the spec iteration number (not the product version), that should be documented. If it's meant to match the product version, it should be `4.0.0`. Inconsistent directory naming makes it unclear whether specs are versioned independently from the product.

- Suggestion: Rename directory to `4.0.0` to match the product version, or add a README in the specs directory explaining that spec iteration numbers are independent of product version numbers. Also standardize on either `v4.0` or `v4.0.0` throughout the document.

---

## Finding 5: Typo in "one-block-per-concern"

- Severity: low

- Location: goal.md (What v4.0 delivers, item 4)

- Issue: "one-block-per-concern" should be "one-block-per-concern" — "concern" is misspelled as "concern." This appears in a prominent deliverable bullet and diminishes document polish. The spelling error is repeated exactly the same way, making it a consistent but wrong pattern rather than a one-off typo.

- Suggestion: Correct to "one-block-per-concern."

---

## Finding 6: Companion docs list is incomplete

- Severity: low

- Location: goal.md (header metadata line: "Companion docs: `horizontal_design.md`, `vertical_design.md`, `enums.md`")

- Issue: The companion docs metadata lists three files but the `0.4.0/` directory contains five spec documents: `architecture.md` and `overall.md` are also present. The header says "sub-specs and plans next" but `architecture.md` is already locked and integral to the design. A reader relying on the companion docs list to orient themselves will miss the architectural structure document that defines the three-tier layout, module boundaries, and dependency rules referenced throughout the design.

- Suggestion: Add `architecture.md` to the companion docs list. If `overall.md` is also a companion (it appears to be a combined/aggregate of all docs), add it as well.

---

## Finding 7: "exactly 2" attempt budget for read-only tools is ambiguous

- Severity: medium

- Location: goal.md (Per-category attempt budgets (C9) bullet)

- Issue: The spec states read-only tools get "exactly 2 (no rework)" attempts. The word "exactly" creates ambiguity: does this mean the system always makes 2 attempts regardless of the first attempt's outcome, or that 2 is the hard ceiling and the system stops after 1 if it succeeds? The parenthetical "(no rework)" suggests the annotator pass is a separate stage, not a retry — but "exactly 2 attempts" reads as if there are two implementation attempts. In `horizontal_design.md` C9, this is clarified as 1 implementer + 1 annotator, but the `goal.md` phrasing is misleading to anyone who hasn't read the horizontal design yet.

- Suggestion: Reword to "`read_only` tools get 1 implementer attempt + 1 annotator pass (2 total stages; no rework loops)" to disambiguate.

---

## Finding 8: No concurrency model or resource limits specified

- Severity: medium

- Location: goal.md (Non-goals: "One daemon per machine, fixed configurable port. Concurrent work from multiple cwds is dispatched through a single HTTPListener")

- Issue: The spec establishes that concurrent work from multiple working directories is dispatched through one daemon, but neither `goal.md` nor the companion horizontal design (C1) specifies concurrency limits, connection pooling, or backpressure handling. Without these, the daemon is vulnerable to resource exhaustion: an unbounded number of concurrent batch executions could exhaust memory (each batch holds a provider connection + context), file descriptors (JSONL log handles per batch), or CPU (parallel model calls). The `horizontal_design.md` C1 defers body size caps and explicitly defers resource limits, leaving a gap that could cause production outages under concurrent load.

- Suggestion: Add a max-concurrent-batches configuration parameter to C1 HTTPListener or C6 BoundedExecution, with a sensible default (e.g., 10 concurrent batches) and a 503 rejection mechanism when at capacity.

---

## Finding 9: Telemetry PII-removal is stated as a property but the detection mechanism is in a different document with unclear coverage

- Severity: medium

- Location: goal.md (Two-layer scrubbing (C7) bullet) → horizontal_design.md (C7 TelemetryChannel)

- Issue: The goal doc advertises "PII fields are **removed** (never hashed/stubbed)" as an architectural hallmark. However, the underlying C7 `PrivacyFilter` block in `horizontal_design.md` describes the mechanism only as a "sub-step" inside `TelemetryChannel`. There is no standalone `PrivacyFilter` block contract specifying its input vocabulary, detection rules, or coverage guarantees. This means the PII removal guarantee is a top-level promise without a verifiable implementation contract behind it — during implementation, the team may ship a regex-based filter that misses structured PII in nested JSON, or fails to handle non-English name/address formats, while the spec still claims PII is "removed."

- Suggestion: Promote `PrivacyFilter` to its own block (e.g., C7a) with a contract specifying: detection categories (email, phone, IP, name, address, credential-like), detection strategy per category, handling of nested objects, and a test suite of known-PII payloads that must produce empty output.

---

## Finding 10: No auth mechanism described for the HTTP API

- Severity: high

- Location: goal.md (absent) + horizontal_design.md (C1 Network & Transport)

- Issue: The spec describes `HTTPListener` binding to loopback and a `LoopbackEnforcer` for DNS rebinding defense, but neither `goal.md` nor the companion `horizontal_design.md` C1 mentions API authentication. The current 3.x codebase has no auth middleware on the HTTP handlers. While loopback-only binding limits exposure to local processes, it does not protect against: (a) malicious local processes (e.g., a compromised npm postinstall script), (b) browser-based attacks from `localhost`-origin pages, or (c) cross-user access on shared machines. A local HTTP service that can execute arbitrary shell commands (`toolMode: full`) via delegate/execute-plan without any auth is a privilege-escalation vector.

- Suggestion: Document the auth posture explicitly: either add a shared-secret token (generated on first boot, stored in `~/.mmagent/`) validated as a Bearer token on every request, or document the explicit decision to rely solely on loopback binding and the threat model that accepts local-process risk.

---

## Finding 11: Inconsistent version string format (v4.0.0 vs v4.0 vs 0.4.0)

- Severity: low

- Location: goal.md (title: `# v4.0.0`, body uses `v4.0`, directory is `0.4.0`, `overall.md` filename references `0.4.0`)

- Issue: Three different version formats appear across the spec suite. The title says `v4.0.0` (semver with `v` prefix). The body consistently says `v4.0` (two-component with `v`). The directory is `0.4.0` (three-component, no `v`, and a leading zero that makes it look like a pre-1.0 semver). This inconsistency makes it unclear what version scheme the project uses and whether `0.4.0` is a spec iteration independent of the product version.

- Suggestion: Standardize on one format. If the product version is `4.0.0`, rename the directory to `4.0.0` and use `v4.0.0` consistently in prose. If spec iterations are versioned independently, document that convention explicitly.

---

## Summary

| Severity | Count | Key Themes |
|----------|-------|------------|
| critical | 0 | — |
| high | 2 | Unauthenticated local HTTP API with shell access; PII detection strategy is an unverifiable promise |
| medium | 5 | Contradictory LOC ceiling spec; undefined cross-references; ambiguous attempt budget; missing concurrency limits; PII filter lacks contract |
| low | 4 | Version inconsistency; typo; incomplete companion doc listing; version format proliferation |

The spec suite is structurally sound — the three-tier architecture, closed enums, and block-contract approach are well-reasoned. The findings cluster around two themes: **security posture is underspecified** (no auth, PII detection is hand-waved) and **cross-document consistency is loose** (contradictory 500-LOC rule, unreferenced companion docs, ambiguous attempt budgets). The high-severity auth gap deserves a decision before implementation begins; the medium findings should be resolved during sub-spec refinement.
