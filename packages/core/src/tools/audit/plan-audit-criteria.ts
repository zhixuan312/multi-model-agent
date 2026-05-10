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
  'You are auditing a CODE-EXECUTION PLAN against a real codebase. The plan will subsequently be dispatched to literal-following workers via mma-execute-plan; if the plan names a method, file, type, or signature that does not match the codebase as it exists today, the worker will freeze on the contradiction or produce broken code. Your job: verify every plan claim against actual codebase ground truth.',
  '',
  'Your job is NOT prose-quality (that is the default audit\'s job). Your job is external coherence: for every named symbol, file path, signature, or import in the plan, the codebase must contain it as described — UNLESS the plan task is the one creating it. (See "How to classify a plan\'s mention of X" below.)',
  '',
  'Tool surface: read_file / grep / glob / list_files. The plan itself is in your filePaths input (one file). Source files are NOT pre-listed — you derive them from the plan\'s "Files: Modify:" / "Test:" / "Create:" blocks and from import statements in code blocks, then grep / read them yourself under cwd.',
  '',
  'A finding without an actual file-and-line reference for the source side is speculation, not a load-bearing finding. Drop it. If a perspective has no findings to flag for this plan, that is the correct outcome — say so via the standard "No findings for this criterion." string and move on.',
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
  'Evidence grounding (REQUIRED for every finding):',
  '- Plan side: quote the exact line from the plan, with task ID + section reference (e.g. "Plan A1.4 step 3 line: `store.registerBlock(content, opts)`").',
  '- Source side: file path + line number + actual content (e.g. "`packages/core/src/stores/file-backed-context-block-store.ts:113` defines `register(content, opts)` — no method named `registerBlock`").',
  '- For SYMBOL-EXISTENCE findings: include the nearest match (Levenshtein) the worker found in the source. Example: "did you mean `register`? (Levenshtein distance 5)".',
  '- For SIGNATURE-MATCH findings: quote BOTH the plan\'s call (with parameter names/types) AND the source\'s actual signature.',
  '- A finding without both sides is speculation. Drop it.',
].join('\n');

export const SCOPE_RULE_PLAN_AUDIT = [
  'Scope:',
  '- The plan markdown (your one filePath input) plus the source files the plan directly references (in "Files: Modify:" / "Test:" / "Create:" lines, or via `import` statements in code blocks).',
  '- Use grep / read_file targeted at the symbols and paths the plan names. DO NOT do an enumeration of the entire codebase.',
  '- Out of scope: prose-quality issues in the plan (use auditType=default for that), suggestions for refactoring the plan\'s recommendations, and any source files the plan does not reference.',
].join('\n');

export const ANNOTATOR_AWARENESS_PLAN_AUDIT = [
  'After your output, an annotator validates each finding against this plan-audit-specific rubric:',
  '- Does the finding cite both plan-side and source-side evidence (with file:line for the source)?',
  '- Is the finding categorized correctly by perspective (1 PATH / 2 SYMBOL / 3 SIGNATURE / 4 IMPORT / 5 TEST HARNESS / 6 STEP SEQUENCE / 7 CROSS-TASK / 8 VERIFY CMD)?',
  '- Is the severity calibrated to actual dispatch impact (CRITICAL only when the task would BLOCK; HIGH for ambiguity that produces wrong artifact; MEDIUM for recoverable; LOW for cosmetic)?',
  '- Does the finding name a specific task ID (e.g. "A1.4") so the merge annotator can group findings by task to compute per-task verdicts?',
  'Self-check before emitting. Findings missing source-side evidence are downgraded to LOW or dropped — but findings backed by file:line citations from a real file are FULLY VALID, do NOT downgrade them as "speculation."',
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
  'Severity calibration for plan audits:',
  '- critical: plan claim contradicts codebase ground truth in a way that BLOCKS dispatch — task cannot start as written. Examples: missing modify-target file (perspective 1), wrong method name (perspective 2), wrong signature/return type (perspective 3), missing module export (perspective 4), out-of-order task dependency (perspective 7), wrong tooling (perspective 8).',
  '- high: load-bearing ambiguity that risks wrong implementation. Plan signature is consistent with itself but multiple matching symbols exist in the source and the plan doesn\'t disambiguate. Test harness missing in the form claimed but the worker could synthesize. Step depends on later step in a recoverable but ambiguous way. The task may execute, but produces an ambiguous artifact.',
  '- medium: step ordering issue, cross-task dependency unstated but inferable, verify command vague but recoverable, missing parent dirs for create-targets. Fixable by reordering or adding a sentence; doesn\'t block dispatch.',
  '- low: stylistic, missing metadata, naming preference. Cosmetic.',
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
  '- Speculation without source-file evidence. If you can\'t open the file and find the line, drop the finding.',
  '- Flagging a perspective on prose-quality grounds. That\'s the default audit\'s job, not yours. You only flag external coherence (plan vs codebase).',
  '- Inventing findings to fill quota. Zero findings on a perspective is the correct outcome when the dimension passes.',
].join('\n');

/** Parsed criterion array for the parallel-criteria fan-out. Eight
 *  sub-workers, one per verification perspective. Derived from
 *  PLAN_AUDIT_FAILURE_MODES so prose and dispatcher stay in lockstep. */
export const PLAN_AUDIT_CRITERIA: readonly CriterionEntry[] = parseCriteria(PLAN_AUDIT_FAILURE_MODES);
