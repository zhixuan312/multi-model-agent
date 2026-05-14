/**
 * Plan-audit failure-mode taxonomy (4.2.3+).
 *
 * Drives the parallel-criteria fan-out for `auditType: 'plan'` audits.
 * Each numbered entry below becomes one sub-worker assigned to a single
 * verification dimension. Sub-workers run on the existing complex tier
 * with read-only tools (read_file / grep / glob / list_files); they
 * derive source files to verify from the plan itself, then ground each
 * finding in actual file-and-line evidence.
 *
 * A perspective emitting zero findings means "this dimension passes for
 * this plan." That is the EXPECTED outcome for several perspectives on
 * a clean plan; the merge annotator does NOT inflate severity to fill
 * a quota.
 *
 * Contrast with DOC_AUDIT_FAILURE_MODES (in implementer-criteria.ts):
 * those 11 categories are prose-INTERNAL coherence (ambiguity,
 * contradiction, drift between sections). The 8 perspectives below are
 * EXTERNAL coherence — does the plan match the codebase?
 */

import { parseCriteria, type CriterionEntry } from '../criteria-types.js';

/** Orientation block — goes at the top of every plan-audit sub-worker
 *  prompt. Contrast with AUDIT_PURPOSE_ORIENTATION (prose-coherence
 *  audit): plan-audit sub-workers verify EXTERNAL coherence (plan vs
 *  codebase), not internal-coherence. */
export const PLAN_AUDIT_PURPOSE_ORIENTATION = [
  'Why this audit exists:',
  'You are auditing a CODE-EXECUTION PLAN against a real codebase AND (when provided) against the upstream requirement spec. The plan will subsequently be dispatched to literal-following workers via mma-execute-plan; if the plan names a method, file, type, or signature that does not match the codebase as it exists today, the worker will freeze on the contradiction or produce broken code. If the plan silently skips a spec requirement, the implementation will ship incomplete. Your job: verify every plan claim against the actual codebase, and (when the spec is available) verify every spec requirement is covered by at least one task.',
  '',
  'Your job is NOT prose-quality on the plan itself (that is the default audit\'s job). Your job splits into three groups of perspectives:',
  '  • EXTERNAL CODEBASE COHERENCE (perspectives 1–8) — for every named symbol, file path, signature, or import in the plan, the codebase must contain it as described UNLESS the plan task is the one creating it. (See "How to classify a plan\'s mention of X" below.) These perspectives REQUIRE source-side evidence (file:line).',
  '  • INTRA-PLAN STRUCTURE (perspectives 9, 11, 12) — task granularity, placeholder language, and required plan skeleton. These perspectives look ONLY at the plan markdown itself; no codebase grounding is needed.',
  '  • SPEC ALIGNMENT (perspective 10) — every load-bearing spec requirement maps to ≥1 task in the plan, and no task implements something the spec did not ask for. This perspective requires the reference SPEC to be available in your context (registered as a context block by the caller). If no spec is in context, emit "No findings for this criterion." for perspective 10 ONLY — do NOT skip the other perspectives.',
  '',
  'Tool surface: read_file / grep / glob / list_files. The plan itself is in your filePaths input (one file). Source files are NOT pre-listed — you derive them from the plan\'s "Files: Modify:" / "Test:" / "Create:" blocks and from import statements in code blocks, then grep / read them yourself under cwd. The reference SPEC, when provided, lives in the cached prefix above as a registered context block — read it directly from there for perspective 10.',
  '',
  'A finding without an actual file-and-line reference for the source side is speculation FOR PERSPECTIVES 1–8 ONLY. Drop those. Perspectives 9, 11, 12 are intra-plan and need only a plan-side quote. Perspective 10 needs a spec-side quote (the requirement) plus a plan-side reference (the task that does or does not cover it). If a perspective has no findings to flag for this plan, that is the correct outcome — say so via the standard "No findings for this criterion." string and move on.',
  '',
  '— BEFORE FLAGGING — How to classify a plan\'s mention of X (REQUIRED triage step):',
  '',
  'Plans contain TWO different kinds of symbol mention. Confusing them is the #1 way plan-audits over-flag and produce false positives. Before any SYMBOL EXISTENCE / SIGNATURE MATCH / IMPORT GRAPH finding, classify the mention:',
  '',
  '**USE intent** — the plan TREATS X as already existing in the codebase. The task ASSUMES the symbol is there. Examples:',
  '  • method calls: `store.register(...)`, `obj.helper(...)`, `await provider.run(...)`',
  '  • property/field access: `config.someField`, `result.cost`, `this._ttlMs`',
  '  • import statements: `import { X } from "./bar.js"`',
  '  • type references: `function f(arg: X)`, `: Promise<X>`, `: ExistingInterface`',
  '  • test code calling production code: `expect(store.register(...))`',
  '',
  '**DEFINE intent** — the plan CREATES X in this task. X is the deliverable. Examples:',
  '  • function/method declarations: `function foo()`, `private foo()`, `static foo()`, `async foo()`',
  '  • class/interface/type declarations: `class Foo {}`, `interface Bar {}`, `type Q = ...`, `enum E {}`',
  '  • exported constants: `export const baz = ...`, `export function ...`',
  '  • new fields added to existing types: `interface ExistingType { newField: X }`',
  '  • new option keys on existing methods: `register(content: string, opts: { newOpt: X })`',
  '  • new test files via "Test: <path> (new)"',
  '  • new modules via "New: <path>" or "Create: <path>"',
  '',
  '**Verification rule by intent:**',
  '  • USE intent → the symbol MUST exist in the named source file. If grep returns no match → flag (CRITICAL, "did you mean: <nearest match>").',
  '  • DEFINE intent → the symbol MAY NOT exist yet. The task is the one adding it; that is the deliverable. **DO NOT FLAG.** This is the most common false-positive trap in plan audits.',
  '  • DEFINE intent + symbol DOES already exist in source → flag MEDIUM "task is obsolete; this deliverable already shipped — plan needs trimming."',
  '',
  '**Task scope = a unit.** Each `### Task X.Y:` heading + its `Files:` block + its numbered steps + their code blocks form ONE UNIT. Read the unit as a whole before flagging. Do not extract a symbol from a code block in isolation. Specifically: a `private findByContentSha(...) { … }` definition appearing inside Task A1.4\'s code block, where the task\'s `Files:` block names the implementation file as `Modify:`, is the task INTRODUCING that helper — not the task ASSUMING it already exists. Look at the task\'s intent before flagging the symbol.',
  '',
  'Heuristic for fast classification: if the plan\'s code block has a function/method declaration syntax ON THE SAME LINE as the symbol name, it\'s DEFINE intent. If the symbol appears as a callee, an imported name, a type annotation, or a property access, it\'s USE intent.',
].join('\n');

export const EVIDENCE_RULE_PLAN_AUDIT = [
  'Evidence grounding (REQUIRED for every finding — evidence shape varies by perspective group):',
  '',
  'Perspectives 1–8 (EXTERNAL CODEBASE COHERENCE) — both sides REQUIRED:',
  '- Plan side: quote the exact line from the plan, with task ID + section reference (e.g. "Plan A1.4 step 3 line: `store.registerBlock(content, opts)`").',
  '- Source side: file path + line number + actual content (e.g. "`packages/core/src/stores/file-backed-context-block-store.ts:113` defines `register(content, opts)` — no method named `registerBlock`").',
  '- For SYMBOL-EXISTENCE findings: include the nearest match (Levenshtein) the worker found in the source. Example: "did you mean `register`? (Levenshtein distance 5)".',
  '- For SIGNATURE-MATCH findings: quote BOTH the plan\'s call (with parameter names/types) AND the source\'s actual signature.',
  '- A finding without both sides on perspectives 1–8 is speculation. Drop it.',
  '',
  'Perspective 10 (SPEC-COVERAGE) — both sides REQUIRED:',
  '- Spec side: quote the exact `shall` / `must` / `should` clause (or the acceptance-criterion line) from the registered spec context block.',
  '- Plan side: name the task that does (or does NOT) cover it. For absence findings: "no task in this plan implements <spec clause>". For scope-creep findings: "task X.Y implements <plan-side claim>, which has no corresponding spec requirement".',
  '',
  'Perspectives 9, 11, 12 (INTRA-PLAN STRUCTURE) — plan-side quote sufficient:',
  '- Quote the exact plan line that demonstrates the issue, with task ID + section reference. No codebase or spec evidence is needed; these are intra-document checks.',
  '- For absence findings (e.g. missing Goal/Architecture header, missing Files: block, missing commit step): name the section that SHOULD contain it and confirm it does not.',
  '',
  'Severity binding for all perspectives: critical = task BLOCKED at dispatch; high = ambiguous artifact; medium = recoverable with reordering or one-sentence edit; low = cosmetic.',
].join('\n');

export const SCOPE_RULE_PLAN_AUDIT = [
  'Scope:',
  '- The plan markdown (your one filePath input), plus the source files the plan directly references (in "Files: Modify:" / "Test:" / "Create:" lines, or via `import` statements in code blocks), plus the reference SPEC if it was registered as a context block in your cached prefix.',
  '- Use grep / read_file targeted at the symbols and paths the plan names. DO NOT do an enumeration of the entire codebase.',
  '- For perspective 10 (SPEC-COVERAGE): the spec lives in the registered context block above. Walk its requirement clauses against the plan\'s tasks; do NOT grep the codebase for spec content — that is not the perspective\'s job.',
  '- Out of scope: prose-quality issues in the plan beyond placeholder-language scanning (use auditType=default for general prose quality), suggestions for refactoring the plan\'s recommendations, and any source files the plan does not reference.',
].join('\n');

export const ANNOTATOR_AWARENESS_PLAN_AUDIT = [
  'After your output, an annotator validates each finding against this plan-audit-specific rubric:',
  '- Does the finding cite the right evidence shape for its perspective group? (1–8: plan-side quote + source-side file:line; 10: spec-side clause quote + plan-side task reference; 9/11/12: plan-side quote alone, no codebase grounding needed.)',
  '- Is the finding categorized correctly by perspective (1 PATH / 2 SYMBOL / 3 SIGNATURE / 4 IMPORT / 5 TEST HARNESS / 6 STEP SEQUENCE / 7 CROSS-TASK / 8 VERIFY CMD / 9 TASK GRANULARITY / 10 SPEC COVERAGE / 11 PLACEHOLDER LANGUAGE / 12 PLAN SKELETON)?',
  '- Is the severity calibrated to actual dispatch impact (CRITICAL only when the task would BLOCK; HIGH for ambiguity that produces wrong artifact; MEDIUM for recoverable; LOW for cosmetic)?',
  '- Does the finding name a specific task ID (e.g. "A1.4") so the merge annotator can group findings by task to compute per-task verdicts? For plan-level findings that do not attach to a single task (e.g. missing top-level header, spec requirement with no covering task), use the task ID "META".',
  'Self-check before emitting. Findings on perspectives 1–8 missing source-side evidence are downgraded to LOW or dropped — but findings backed by file:line citations from a real file are FULLY VALID, do NOT downgrade them as "speculation." Findings on perspectives 9, 11, 12 with only a plan-side quote are FULLY VALID — they are intra-plan checks by design.',
].join('\n');


export const PLAN_AUDIT_FAILURE_MODES = [
  'Plan-audit perspectives — applicable to code-execution plans being audited against a real codebase. Each perspective is one verification dimension; emitting zero findings for a perspective means "this dimension passes for this plan." Do not invent findings to hit a quota — if a perspective has nothing to flag, stay silent for that dimension. Apply each perspective end-to-end across every task in the plan. Use read_file / grep / glob / list_files to ground every finding in actual file-and-line evidence; findings without a real source-side reference are not load-bearing and must be dropped.',
  '',
  '1. PATH EXISTENCE — every line under a task\'s "Files:" block must resolve correctly per its label. Sub-rules: (a) "Modify: <path>" → file MUST exist on disk; missing = CRITICAL (the task cannot start). (b) "Test: <path>" or "Test: <path> (new)" → parent directory MUST exist; the test file itself may or may not exist. (c) "New: <path>" or "Create: <path>" → parent directory MUST exist AND the file MUST NOT exist (if it does, the task is obsolete — plan needs trimming, MEDIUM). Use list_files / read_file to verify. CRITICAL on missing modify-targets or missing parent dirs. MEDIUM on already-existing create-targets.',
  '',
  '2. SYMBOL EXISTENCE — for every method / type / class / function / imported identifier appearing inside ```ts``` or ```typescript``` code blocks under a task: FIRST classify the mention as USE or DEFINE intent (see the orientation block above). ONLY flag USE-intent mentions where grep against the named source file returns no match. DEFINE-intent mentions are the task\'s deliverable — DO NOT FLAG. Plan says `store.registerBlock(...)` (USE — method call on existing object) against `file-backed-context-block-store.ts`? grep the file; if not found, CRITICAL with nearest match. Plan defines `private findByContentSha(...) { … }` (DEFINE — declaration syntax) inside a Modify-target code block? skip — the task is creating the helper. Always include the actual nearest match (Levenshtein) on USE-intent findings so the plan can be fixed in one edit.',
  '',
  '3. SIGNATURE MATCH — when the plan\'s code uses a method with specific parameters or expects a specific return shape, the actual signature in the source must match. Same intent rule applies: ONLY flag for USE-intent mentions (calls or imports). When the plan DEFINES a method or extends an interface signature, that\'s the deliverable — don\'t flag. Plan calls `register(content, { ttlMs: 60_000 })` (USE) but actual signature is `register(content, opts: { id?: string })` with no `ttlMs`? CRITICAL — call would fail at build. Plan ALSO has a step adding `ttlMs?: number` to the interface (DEFINE)? skip the DEFINE; flag only the call site if the call appears BEFORE the interface-extension step within the task\'s numbered sequence (out-of-order — see perspective 6).',
  '',
  '4. IMPORT GRAPH — every `import { X } from \'…\'` line in code blocks must resolve under the same intent rule. Imports inside test code are USE intent (the imported symbol must exist somewhere). Imports of NEW modules the task creates (e.g. `import { sweepProjectCap } from \'./context-block-project-cap.js\'` when the same task\'s "Files: New:" block lists `context-block-project-cap.ts`) are DEFINE-adjacent — don\'t flag the import itself, but DO flag if the task forgets to also add the corresponding `exports` entry in the workspace package.json (HIGH — the build will fail).',
  '',
  '5. TEST HARNESS AVAILABILITY — when the plan introduces test code, every helper / factory / fixture the test USES (calls / imports) must exist at the named path. `mockProvider`, `startTestServerWithAgents`, `mkdtempSync`, `mockAdapter`, etc. — verify via grep. **However**: if the task explicitly says it adds a new option to an existing helper (e.g. "extend `startTestServerWithAgents` to accept `configOverrides`"), that\'s DEFINE intent — don\'t flag the new option, but DO flag if the test code uses the new option BEFORE the task\'s numbered step that adds it (out-of-order, perspective 6). Helper truly missing (no path, no related task) = HIGH.',
  '',
  '6. STEP SEQUENCE WITHIN TASK — within a single task, the numbered steps must be executable in order. Step 4 says "verify the test passes" — was step 3 the implementation that the test exercises? Step 7 references `helper()` — was it defined by an earlier step or in source? No step depends on output from a later step. Severity MEDIUM unless the dependency would actually halt execution (then HIGH).',
  '',
  '7. CROSS-TASK DEPENDENCIES — when task B\'s code uses something task A introduces (a method, a type, a config field), the plan\'s task ordering must reflect the dependency. Plan A1.5 calls `findByContentSha()` defined by A1.4 but A1.5 appears earlier? CRITICAL — execution would fail. Less severe: dependency exists but is undeclared in the task description (no "depends on A1.4" note). MEDIUM.',
  '',
  '8. VERIFICATION COMMAND VALIDITY — every "Run: <command>" / "verify" instruction in the plan must work with the project\'s actual tooling. Plan says `npm run validate-things` — does package.json have that script? Plan says `npx vitest run tests/foo.test.ts` — does that path exist (after the task\'s implementation lands)? Plan says `cargo test` in a TypeScript project? CRITICAL. Vague verification ("run the test") with no concrete command? MEDIUM — workable but the worker has to guess.',
  '',
  '9. TASK GRANULARITY — each task should be implementable in one focused sub-agent run. Flag tasks that are oversized for single-run execution. Concrete signals (any one or in combination): the task touches more than 3 distinct source files; the task\'s code blocks contain more than ~40 net lines of diff; the task mixes unrelated concerns (e.g. extending a config schema AND adding a new module AND wiring a CLI flag in one task heading); the task lists more than ~6 numbered steps. Severity HIGH when the task clearly exceeds standard-tier capacity (would force escalation to complex tier or thrash through review/rework rounds); MEDIUM when borderline. Suggested fix: split into atomic sub-tasks, one per file or one per concept, each with its own "Files:" block and numbered steps. The audit-fix loop iterates: author re-runs plan-audit, sees tasks downsized, re-audits until clean. This perspective is the upstream complement to perspective 6 (STEP SEQUENCE WITHIN TASK) — perspective 6 catches ordering bugs WITHIN a task; this one catches "task is too big to be one task at all."',
  '',
  '10. SPEC COVERAGE — every load-bearing requirement in the reference SPEC maps to at least one task in this plan, and no task implements a deliverable the spec did not ask for. Requires the spec to be available in your context (registered by the caller as a context block; read it from the cached prefix above). If no spec is in context, emit "No findings for this criterion." — that is the correct outcome when the caller did not provide one. When the spec IS in context, walk each `shall` / `must` / `should` clause (and each named acceptance criterion or architecture component) against the plan\'s task list. For each unmapped requirement: severity CRITICAL when load-bearing (the feature does not work without it), HIGH when supporting (test coverage, observability hook, non-functional requirement that the spec marked as required). For scope-creep (task implements something the spec did not request): severity HIGH if the work is substantive (>1 task or new deliverable), MEDIUM if minor (extra polish that does not affect cost / risk). Implicit mapping (task plausibly covers the requirement but does not say so explicitly) is MEDIUM with the suggested fix: add an explicit "Covers spec requirement: <quote>" line to the task description. Use task ID "META" for findings that point at an uncovered requirement (the task does not exist).',
  '',
  '11. PLACEHOLDER LANGUAGE — scan every task\'s steps and code blocks for prose patterns that the writing-plans skill classifies as "plan failures" because they leave a literal-following worker unable to act. Concrete signals: bare phrases `TBD`, `TODO`, `implement later`, `fill in details`, `Add appropriate error handling`, `add validation`, `handle edge cases`, `Similar to Task N` (without repeating the code), `Write tests for the above` (without showing the test code); steps that describe what to do without showing how when the step changes code (missing code block); verification instructions like `make sure it works` or `run the test` with no concrete command. Severity HIGH on load-bearing steps that cannot be executed without invention (e.g. an implementation step with no code block, a "TBD" in the middle of a task\'s numbered list); MEDIUM on vague verification instructions (worker has to guess but can recover); LOW on cosmetic placeholders in non-load-bearing prose (e.g. a "TODO: link to design doc" in the plan\'s preamble). Evidence is the exact placeholder quote with task ID + step number; no codebase grounding needed.',
  '',
  '12. PLAN SKELETON — the plan must carry the required structural scaffolding so a worker knows what the plan is for and where each task fits. Concrete signals to flag: missing or empty top-level header (`Goal:` / `Architecture:` / `Tech Stack:` lines); missing top-level File Structure section that maps the files-to-touch with their responsibilities before the task list begins; a task that has no `Files:` block (so the worker cannot tell which files to Create / Modify / Test); a task that has no commit step at the end (frequent-commits discipline is a writing-plans hard rule). Severity MEDIUM for missing required-header fields and missing per-task `Files:` blocks (worker can still execute but loses framing or has to derive file scope from code blocks); HIGH when the missing structure forces ambiguous file-scope decisions (e.g. a task whose code blocks reference multiple files but has no `Files:` block to say which is the modify target); LOW for missing commit steps and other discipline gaps. Evidence is plan-side: name the section that should contain the structure and confirm it is absent. Use task ID "META" for plan-level skeleton findings; use the specific task ID for per-task skeleton findings.',
  '',
  'Severity calibration for plan audits:',
  '- critical: plan claim contradicts codebase ground truth in a way that BLOCKS dispatch, OR a load-bearing spec requirement has zero covering tasks. Examples: missing modify-target file (perspective 1), wrong method name (perspective 2), wrong signature/return type (perspective 3), missing module export (perspective 4), out-of-order task dependency (perspective 7), wrong tooling (perspective 8), uncovered load-bearing spec requirement (perspective 10).',
  '- high: load-bearing ambiguity that risks wrong implementation. Plan signature is consistent with itself but multiple matching symbols exist in the source and the plan doesn\'t disambiguate. Test harness missing in the form claimed but the worker could synthesize. Step depends on later step in a recoverable but ambiguous way. Oversized task that must be split (perspective 9). Substantive scope-creep with no spec backing (perspective 10). Placeholder language on a load-bearing step (perspective 11). Missing `Files:` block that forces ambiguous file-scope (perspective 12). The task may execute, but produces an ambiguous artifact.',
  '- medium: step ordering issue, cross-task dependency unstated but inferable, verify command vague but recoverable, missing parent dirs for create-targets, implicit spec mapping (perspective 10 — task plausibly covers a requirement but does not say so), vague verification instructions (perspective 11), missing required header / Files block on a single task (perspective 12). Fixable by reordering or adding a sentence; doesn\'t block dispatch.',
  '- low: stylistic, missing metadata, naming preference, cosmetic placeholder in non-load-bearing prose, missing commit step. Cosmetic.',
  '',
  'Per-task verdict (the merge-annotator computes this from all sub-worker findings):',
  '- EXECUTABLE: zero CRITICAL or HIGH findings against this task across all 8 perspectives.',
  '- PARTIAL: one or more HIGH findings, no CRITICAL. Task may execute but produces an ambiguous result.',
  '- BLOCKED: one or more CRITICAL findings. Task cannot be dispatched as written; a literal worker would freeze.',
  '',
  'Output format for each finding:',
  '- Task ID (e.g., "A1.4") that the finding affects.',
  '- Perspective number (1-8) and name.',
  '- Plan claim: quote the line + section reference.',
  '- Source reality: file path + line number + actual content.',
  '- Severity (critical / high / medium / low).',
  '- Suggested fix: concrete edit (e.g. "rename `registerBlock` → `register` in plan A1.4 step 3", or "rename source method to match plan").',
  '',
  'Anti-patterns to avoid:',
  '- Speculation without source-file evidence ON PERSPECTIVES 1–8. If you can\'t open the file and find the line, drop the finding for those perspectives. Perspectives 9, 11, 12 are intra-plan and do not need source evidence — quoting the plan IS the evidence.',
  '- Flagging general prose-quality on the plan. That\'s the default audit\'s job. You flag external coherence (perspectives 1–8), plan-vs-spec coverage (perspective 10), task granularity (perspective 9), the specific placeholder-language patterns in perspective 11, and the specific structural skeleton requirements in perspective 12. Other prose nits (sentence flow, paragraph organization, tone) are out of scope.',
  '- Flagging perspective 10 (SPEC COVERAGE) without a spec in context. If no spec was registered, emit "No findings for this criterion." for perspective 10 — do not invent the spec or grep for it elsewhere.',
  '- Inventing findings to fill quota. Zero findings on a perspective is the correct outcome when the dimension passes.',
].join('\n');

/** Parsed criterion array for the parallel-criteria fan-out. Eight
 *  sub-workers, one per verification perspective. Derived from
 *  PLAN_AUDIT_FAILURE_MODES so prose and dispatcher stay in lockstep. */
export const PLAN_AUDIT_CRITERIA: readonly CriterionEntry[] = parseCriteria(PLAN_AUDIT_FAILURE_MODES);
