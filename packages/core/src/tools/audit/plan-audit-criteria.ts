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
  'Your job is NOT prose-quality (that is the default audit\'s job). Your job is external coherence: for every named symbol, file path, signature, or import in the plan, the codebase must contain it as described.',
  '',
  'Tool surface: read_file / grep / glob / list_files. The plan itself is in your filePaths input (one file). Source files are NOT pre-listed — you derive them from the plan\'s "Files: Modify:" / "Test:" / "Create:" blocks and from import statements in code blocks, then grep / read them yourself under cwd.',
  '',
  'A finding without an actual file-and-line reference for the source side is speculation, not a load-bearing finding. Drop it. If a perspective has no findings to flag for this plan, that is the correct outcome — say so via the standard "No findings for this criterion." string and move on.',
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
  '1. PATH EXISTENCE — every "Modify: <path>" / "Test: <path>" / "Create: <path>" line under a task\'s "Files:" block must resolve. For modify-targets, the file must exist on disk; for create-targets, the parent directory must exist. Use list_files / read_file to verify. Severity: CRITICAL on missing modify-targets (the task would fail to start), MEDIUM on missing parent dirs for create-targets (workable: the task can mkdir, but it\'s drift the plan should call out).',
  '',
  '2. SYMBOL EXISTENCE — for every method / type / class / function / imported identifier appearing inside ```ts``` or ```typescript``` code blocks under a task: open the named source file (the "Files: Modify:" target) and verify the symbol is defined or imported there. Use grep with the symbol name. Plan says `store.registerBlock(...)` against `file-backed-context-block-store.ts`? grep the file. Not found = CRITICAL drift. Always include the actual nearest match (Levenshtein, e.g. "did you mean `register`?") in the finding so the plan can be fixed in one edit.',
  '',
  '3. SIGNATURE MATCH — when the plan\'s code calls a method with specific parameters or expects a specific return shape, the actual signature in the source must match. Plan passes `opts.ttlMs` but the actual interface has no `ttlMs`? CRITICAL. Plan expects `Promise<X>` from a sync method? CRITICAL. This goes deeper than perspective 2: even when the symbol exists, its semantic shape might not match the plan\'s expectation. Read the source to extract the real signature, then compare.',
  '',
  '4. IMPORT GRAPH — every `import { X } from \'…\'` line in code blocks must resolve. The named module exports `X`; subpath imports of workspace packages (`@zhixuan92/multi-model-agent-core/foo/bar`) have a matching entry under `exports` in the package\'s `package.json`. Plan that adds a new subpath import without also instructing the package.json change = HIGH (workable but missing a step that will fail at build).',
  '',
  '5. TEST HARNESS AVAILABILITY — when the plan introduces test code, every helper function / factory / fixture file the test imports must exist at the import path used. `mockProvider`, `startTestServerWithAgents`, `mkdtempSync`, `mockAdapter`, etc. — verify each via read_file or grep. Plan that uses a helper which doesn\'t exist or has a different name = HIGH (worker can recreate but it\'s drift the plan should call out as a prerequisite step).',
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
