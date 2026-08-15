import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative as relativePath, resolve, sep } from 'node:path';

/**
 * Parses and validates the deliverable-agnostic Contract Task grammar that
 * contract-first plans (produced by the `plan` task type) author for
 * `execute_plan` to consume. This grammar makes no assumption that the
 * deliverable is code: a task never names an implementation file, and a
 * deterministic check is optional, not mandatory.
 *
 * A Contract Task is a `### Task <roman>-<n>:` heading section containing:
 *  - a `**Output:**` line declaring the task's deliverable output (a path,
 *    an artifact name, or free text — never final deliverable content);
 *  - a `**Dependencies:**` line declaring what the task depends on (other
 *    tasks, approved inputs, or "none");
 *  - the five literal Contract bullets, in this exact order and label text:
 *    `Inputs / Request:`, `Outputs / Response:`, `Data mapping:`, `Errors:`,
 *    `Behavior / invariants:`;
 *  - an OPTIONAL `Checks (plan-authored` block containing zero or more
 *    declared checks, each exactly one `Check:` line naming a destination
 *    path, exactly one complete fenced source block, and exactly one `Run:`
 *    command (a shell-metacharacter-free argv, safe for `execFile(cmd,
 *    args[])` with `shell: false`). A task that declares no check produces
 *    `acceptanceTests: []` — that is not an error;
 *  - the exact closing line `**Plan boundary:** final deliverable content is
 *    not in this plan.`
 *
 * This module owns parsing that shape into an immutable snapshot, validating
 * declared check destination paths are safe repository-relative paths beneath
 * one of the `ACCEPTED_CHECK_ROOTS` (not `tests/` alone — a Python project uses
 * `test/`, Java uses `src/test/java`, and a report whose check reconciles
 * figures against a ledger belongs under `checks/`), and materializing /
 * re-materializing the plan-authored check sources verbatim to disk. Only a task that declares a deterministic
 * check produces a materialized file and a scored command; a no-check task
 * is fully skipped by both.
 */

type ContractPlanErrorCode =
  | 'unsupported-legacy-plan'
  | 'malformed-plan'
  | 'unsafe-test-path'
  | 'test-path-collision';

export class ContractPlanError extends Error {
  readonly code: ContractPlanErrorCode;

  constructor(code: ContractPlanErrorCode, message: string) {
    super(message);
    this.name = 'ContractPlanError';
    this.code = code;
  }
}

export interface PlanAcceptanceTest {
  readonly path: string;
  readonly source: string;
  readonly command: string;
}

interface ContractClauses {
  readonly inputsRequest: string;
  readonly outputsResponse: string;
  readonly dataMapping: string;
  readonly errors: string;
  readonly behaviorInvariants: string;
}

export interface ParsedContractTask {
  /** Stable identity parsed from the `### Task <id>: …` heading (e.g. `I-1`). This is the key
   *  the reviewer contract matches on — titles are prose and must never be load-bearing. */
  readonly id: string;
  readonly title: string;
  /** The task's declared deliverable output (a path, an artifact name, or free text). Metadata
   *  only — never final deliverable content. */
  readonly output: string;
  /** What the task depends on (other tasks, approved inputs, or "none"). Metadata only. */
  readonly dependencies: string;
  readonly contract: ContractClauses;
  readonly acceptanceTests: readonly PlanAcceptanceTest[];
}

export interface ContractPlanSnapshot {
  readonly tasks: readonly ParsedContractTask[];
}

const CONTRACT_BULLET_LABELS = [
  'Inputs / Request:',
  'Outputs / Response:',
  'Data mapping:',
  'Errors:',
  'Behavior / invariants:',
] as const;

const OUTPUT_FIELD_LABEL = '**Output:**';
const DEPENDENCIES_FIELD_LABEL = '**Dependencies:**';
// Deliberately excludes the leading "**" bold marker — the last Contract bullet's content is
// bounded by this marker's index, and the trailing "**" is stripped from that content afterward.
const CHECKS_HEADING_MARKER = 'Checks (plan-authored';
const PLAN_BOUNDARY_SENTINEL = '**Plan boundary:** final deliverable content is not in this plan.';

const TASK_HEADING_RE = /^###\s+Task\s+[IVXLCDM]+-\d+:.*$/gm;
const SHELL_METACHAR_RE = /[|&;<>$`()'"]/;
// Declared-check block matcher — tolerant of the markdown list form the `mma-plan` generator
// authors (and of the column-0 form). It accepts, on the Check / fence / Run lines: an optional
// `- `/`* ` bullet and leading indentation, an INDENTED fenced source block, optional blank lines
// between the three parts, and trailing prose after the `Run:` command (e.g. "Expected: PASS once
// implemented"). The captured source is dedented and the command is extracted from the Run remainder
// (see below) — so generator output and validator agree without forcing a rigid column-0 shape.
const CHECK_BLOCK_RE = /^[ \t]*(?:[-*][ \t]+)?Check:[ \t]*`?([^\n`]+?)`?[ \t]*\n(?:[ \t]*\n)*[ \t]*```[^\n]*\n([\s\S]*?)\n[ \t]*```[ \t]*\n(?:[ \t]*\n)*[ \t]*(?:[-*][ \t]+)?Run:[ \t]*(.+)$/gm;
// Count declared checks by their `Check:` line, tolerating a leading bullet + indentation.
const CHECK_LINE_RE = /^[ \t]*(?:[-*][ \t]+)?Check:/gm;

function stripBacktick(value: string): string {
  return value.trim().replace(/^`+|`+$/g, '').trim();
}

/** Strip the common leading indentation from a captured (possibly bullet-indented) source block. */
function dedent(source: string): string {
  const lines = source.split('\n');
  const indents = lines.filter(l => l.trim().length > 0).map(l => (l.match(/^[ \t]*/)?.[0].length ?? 0));
  const min = indents.length ? Math.min(...indents) : 0;
  return min === 0 ? source : lines.map(l => l.slice(min)).join('\n');
}

/** Extract the command from a `Run:` line remainder: the backtick-wrapped token if present (trailing
 *  prose like "Expected: PASS" is then outside the backticks and ignored), else the text up to the
 *  first run of 2+ spaces (which separates a bare command from any trailing note). */
function extractCommand(runRemainder: string): string {
  const backticked = runRemainder.match(/`([^`]+)`/);
  return (backticked ? backticked[1]! : runRemainder.split(/\s{2,}/)[0]!).trim();
}

/** Extract a required `**<Label>:**` metadata field's value — the rest of its line. Unlike a
 *  declared check path, this value is descriptive metadata (an output declaration or a
 *  dependency list), so it is returned verbatim (trimmed), not stripped of backticks. */
function extractBoldField(body: string, label: string, title: string, fieldName: string): string {
  const idx = body.indexOf(label);
  if (idx === -1) {
    throw new ContractPlanError('malformed-plan', `Task "${title}" is missing the required "${label}" ${fieldName} declaration`);
  }
  const value = body.slice(idx + label.length).split('\n')[0]!.trim();
  if (!value) {
    throw new ContractPlanError('malformed-plan', `Task "${title}" has an empty "${label}" ${fieldName} declaration`);
  }
  return value;
}

/** Pull the stable id out of a `### Task I-1: …` heading. TASK_HEADING_RE already guaranteed
 *  the shape, so a miss here means the two regexes drifted apart — fail loudly rather than
 *  silently synthesising an id the reviewer could never echo. */
function parseTaskId(headingLine: string, title: string): string {
  const m = headingLine.match(/^###\s+Task\s+([IVXLCDM]+-\d+)\s*:/);
  if (!m) {
    throw new ContractPlanError('malformed-plan', `Task "${title}" has no parseable "Task <roman>-<n>:" identity in its heading`);
  }
  return m[1]!;
}

function parseTaskSection(headingLine: string, body: string): ParsedContractTask {
  const title = headingLine.replace(/^###\s+/, '').trim();
  const id = parseTaskId(headingLine, title);

  const output = extractBoldField(body, OUTPUT_FIELD_LABEL, title, 'output');
  const dependencies = extractBoldField(body, DEPENDENCIES_FIELD_LABEL, title, 'dependencies');

  let cursor = 0;
  const bulletStarts: number[] = [];
  for (const label of CONTRACT_BULLET_LABELS) {
    const idx = body.indexOf(label, cursor);
    if (idx === -1) {
      throw new ContractPlanError('malformed-plan', `Task "${title}" is missing the required Contract bullet "${label}"`);
    }
    bulletStarts.push(idx);
    cursor = idx + label.length;
  }

  const boundaryIdx = body.indexOf(PLAN_BOUNDARY_SENTINEL, cursor);
  if (boundaryIdx === -1) {
    throw new ContractPlanError('malformed-plan', `Task "${title}" is missing the exact closing line "${PLAN_BOUNDARY_SENTINEL}"`);
  }

  // The Checks section is OPTIONAL — a task that declares no deterministic check has no such
  // heading at all, and that is not an error (Contract: "Do not reject a task merely because it
  // has no check"). Only trust a heading found strictly before the mandatory boundary sentinel.
  const rawChecksHeadingIdx = body.indexOf(CHECKS_HEADING_MARKER, cursor);
  const checksHeadingIdx = rawChecksHeadingIdx !== -1 && rawChecksHeadingIdx < boundaryIdx ? rawChecksHeadingIdx : -1;
  const hasChecks = checksHeadingIdx !== -1;

  const bulletContents: string[] = [];
  for (let i = 0; i < CONTRACT_BULLET_LABELS.length; i++) {
    const contentStart = bulletStarts[i]! + CONTRACT_BULLET_LABELS[i]!.length;
    const contentEnd = i < CONTRACT_BULLET_LABELS.length - 1 ? bulletStarts[i + 1]! : (hasChecks ? checksHeadingIdx : boundaryIdx);
    // The last bullet's content is bounded by the Checks heading (or the boundary sentinel when
    // there are no checks), which can leave that marker's leading "**" bold marker attached to
    // the slice; strip it.
    bulletContents.push(body.slice(contentStart, contentEnd).trim().replace(/\*+$/, '').trim());
  }

  const tests: PlanAcceptanceTest[] = [];
  if (hasChecks) {
    const checksBlock = body.slice(checksHeadingIdx, boundaryIdx);

    CHECK_LINE_RE.lastIndex = 0;
    const declaredCheckHeadingCount = (checksBlock.match(CHECK_LINE_RE) ?? []).length;
    if (declaredCheckHeadingCount === 0) {
      throw new ContractPlanError('malformed-plan', `Task "${title}" declares a "${CHECKS_HEADING_MARKER}" section but names no check entries`);
    }

    const seenPaths = new Set<string>();
    CHECK_BLOCK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CHECK_BLOCK_RE.exec(checksBlock)) !== null) {
      const path = stripBacktick(match[1]!);
      const source = dedent(match[2]!);
      const command = extractCommand(match[3]!);

      if (!path) {
        throw new ContractPlanError('malformed-plan', `Task "${title}" has a check with an empty "Check:" path`);
      }
      if (seenPaths.has(path)) {
        throw new ContractPlanError('malformed-plan', `Task "${title}" declares duplicate check path "${path}"`);
      }
      seenPaths.add(path);

      if (!command) {
        throw new ContractPlanError('malformed-plan', `Task "${title}" names check "${path}" but omits its required "Run:" command`);
      }
      if (SHELL_METACHAR_RE.test(command)) {
        throw new ContractPlanError('malformed-plan', `Task "${title}" check "${path}" has a "Run:" command containing unsafe shell metacharacters: "${command}"`);
      }

      tests.push(Object.freeze({ path, source, command }));
    }

    if (tests.length !== declaredCheckHeadingCount) {
      throw new ContractPlanError('malformed-plan', `Task "${title}" has a check block with an unclosed or malformed fenced source block`);
    }
  }

  return Object.freeze({
    id,
    title,
    output,
    dependencies,
    contract: Object.freeze({
      inputsRequest: bulletContents[0]!,
      outputsResponse: bulletContents[1]!,
      dataMapping: bulletContents[2]!,
      errors: bulletContents[3]!,
      behaviorInvariants: bulletContents[4]!,
    }),
    acceptanceTests: Object.freeze(tests),
  });
}

export function parseContractPlan(markdown: string): ContractPlanSnapshot {
  const headingMatches = [...markdown.matchAll(TASK_HEADING_RE)];
  if (headingMatches.length === 0) {
    throw new ContractPlanError('unsupported-legacy-plan', 'Plan has no frozen "### Task <roman>-<n>:" Contract Task sections');
  }

  const tasks: ParsedContractTask[] = [];
  const seenTestPaths = new Set<string>();
  const seenTaskIds = new Set<string>();
  for (let i = 0; i < headingMatches.length; i++) {
    const heading = headingMatches[i]!;
    const start = heading.index!;
    const end = i + 1 < headingMatches.length ? headingMatches[i + 1]!.index! : markdown.length;
    const body = markdown.slice(start, end);
    const task = parseTaskSection(heading[0], body);
    // Ids are the reviewer-contract key, so a duplicate would let one reviewer entry satisfy
    // two dispatched tasks. Reject at parse time rather than mis-matching at validation time.
    if (seenTaskIds.has(task.id)) {
      throw new ContractPlanError('malformed-plan', `Plan declares duplicate Contract Task id "${task.id}"`);
    }
    seenTaskIds.add(task.id);
    for (const test of task.acceptanceTests) {
      if (seenTestPaths.has(test.path)) {
        throw new ContractPlanError('malformed-plan', `Plan declares duplicate acceptance test path "${test.path}" across Contract Tasks`);
      }
      seenTestPaths.add(test.path);
    }
    tasks.push(task);
  }

  return Object.freeze({ tasks: Object.freeze(tasks) });
}

function collectUniqueTests(snapshot: ContractPlanSnapshot): PlanAcceptanceTest[] {
  const byPath = new Map<string, PlanAcceptanceTest>();
  for (const task of snapshot.tasks) {
    for (const test of task.acceptanceTests) {
      if (!byPath.has(test.path)) byPath.set(test.path, test);
    }
  }
  return [...byPath.values()];
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await lstat(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reject a declared check path with a symlinked ancestor, inspecting EVERY segment from the
 * repository root down to the target — not merely the matched root and below.
 *
 * The earlier version started its walk AT the matched root. That was sound while every accepted
 * root was a single top-level directory, because `lstat(repositoryRoot/tests)` inspects `tests`
 * itself. It stopped being sound the moment a NESTED root (`src/test`) was accepted:
 * `lstat(repositoryRoot/src/test)` silently FOLLOWS a symlinked `src` while resolving the path and
 * then reports only on the final `test` component. A repository containing a symlinked `src` — git
 * tracks symlinks, so this is ordinary content, not an exotic setup — would pass validation, and
 * `materializeAcceptanceTests` would then `writeFile` outside the submitted repository root. This
 * is a direct server-side write with no sandbox in front of it.
 *
 * Walking from the repository root removes the whole class: adding another nested root later
 * cannot reintroduce it.
 */
async function assertNoSymlinkAncestors(repositoryRoot: string, absTargetPath: string, declaredPath: string): Promise<void> {
  // `path.relative`, NOT slice arithmetic. Round 3 derived the relative path with
  // `absTargetPath.slice(repositoryRoot.length + 1)`, which silently produces garbage whenever
  // `repositoryRoot` carries a trailing separator or is the filesystem root: for `/repo/` it eats
  // the first character, the walk then starts at a segment that does not exist, breaks on the
  // first iteration, and NO symlink check runs at all. `relative()` is correct for every spelling
  // of the same directory, so the guard cannot be disabled by how the caller wrote its path.
  const relative = relativePath(repositoryRoot, absTargetPath);
  // A target that is not under the root at all must never be walked as though it were. The caller
  // already checked containment, so reaching here means the two disagree — refuse rather than
  // proceed on an assumption.
  if (relative === '' || relative.startsWith('..') || isAbsolute(relative)) {
    throw new ContractPlanError('unsafe-test-path', `Acceptance test path "${declaredPath}" does not resolve inside the repository root`);
  }
  const segments = relative.split(sep).filter(Boolean);
  let current = resolve(repositoryRoot);
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new ContractPlanError('unsafe-test-path', `Acceptance test path "${declaredPath}" has a symlinked ancestor at "${current}"`);
      }
    } catch (err) {
      if (err instanceof ContractPlanError) throw err;
      // This segment does not exist yet. Nothing below it can exist either, so nothing below it
      // can be a symlink — stop rather than reporting a missing directory as unsafe.
      break;
    }
  }
}

export const ACCEPTED_CHECK_ROOTS = ['tests', 'test', 'spec', 'specs', 'checks', '__tests__', 'src/test'] as const;

export async function assertSafeAcceptanceTestPaths(snapshot: ContractPlanSnapshot, repositoryRoot: string): Promise<void> {
  for (const test of collectUniqueTests(snapshot)) {
    if (isAbsolute(test.path)) {
      throw new ContractPlanError('unsafe-test-path', `Acceptance test path "${test.path}" must be relative, not absolute`);
    }
    if (test.path.split(/[\\/]/).includes('..')) {
      throw new ContractPlanError('unsafe-test-path', `Acceptance test path "${test.path}" must not contain traversal segments`);
    }
    const resolved = resolve(repositoryRoot, test.path);
    // The FIRST accepted root the path actually falls under. Checking every root rather than
    // one fixed root is the whole change; everything after it is unchanged.
    const matchedRoot = ACCEPTED_CHECK_ROOTS
      .map((name) => resolve(repositoryRoot, name))
      .find((root) => resolved === root || resolved.startsWith(root + sep));
    if (!matchedRoot) {
      throw new ContractPlanError(
        'unsafe-test-path',
        `Acceptance test path "${test.path}" must sit under one of: ${ACCEPTED_CHECK_ROOTS.join(', ')} `
        + `(relative to the submitted cwd). A check for a non-code deliverable belongs under "checks".`,
      );
    }
    await assertNoSymlinkAncestors(repositoryRoot, resolved, test.path);
  }
}

export async function materializeAcceptanceTests(snapshot: ContractPlanSnapshot, repositoryRoot: string): Promise<void> {
  await assertSafeAcceptanceTestPaths(snapshot, repositoryRoot);
  const uniqueTests = collectUniqueTests(snapshot);

  for (const test of uniqueTests) {
    const abs = resolve(repositoryRoot, test.path);
    if (await pathExists(abs)) {
      throw new ContractPlanError('test-path-collision', `Acceptance test path "${test.path}" already exists; refusing to overwrite it`);
    }
  }

  for (const test of uniqueTests) {
    const abs = resolve(repositoryRoot, test.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, test.source, 'utf8');
  }
}

export async function rematerializeAcceptanceTests(snapshot: ContractPlanSnapshot, repositoryRoot: string): Promise<void> {
  await assertSafeAcceptanceTestPaths(snapshot, repositoryRoot);
  for (const test of collectUniqueTests(snapshot)) {
    const abs = resolve(repositoryRoot, test.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, test.source, 'utf8');
  }
}
