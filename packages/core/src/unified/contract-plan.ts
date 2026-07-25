import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

/**
 * Parses and validates the FROZEN Contract Task template that contract-first
 * plans (produced by the `plan` task type) author for `execute_plan` to consume.
 *
 * A Contract Task is a `### Task <roman>-<n>:` heading section containing:
 *  - an inline `**Files:** ... Test: <path>[, <path>...]` field naming the
 *    plan-authored dedicated acceptance-test path(s) for this task;
 *  - the five literal Contract bullets, in this exact order and label text:
 *    `Inputs / Request:`, `Outputs / Response:`, `Data mapping:`, `Errors:`,
 *    `Behavior / invariants:`;
 *  - an `Acceptance tests (plan-authored` block containing, for EACH declared
 *    test path, exactly one `Path:` line (matching one `Files: ... Test:`
 *    entry), exactly one complete fenced source block, and exactly one
 *    `Run:` command (a shell-metacharacter-free argv, safe for
 *    `execFile(cmd, args[])` with `shell: false`);
 *  - the exact closing line `**Implementation:** left to the executor — no
 *    code in the plan.`
 *
 * This module owns parsing that frozen shape into an immutable snapshot,
 * validating acceptance-test destination paths are safe repository-relative
 * paths beneath `tests/`, and materializing / re-materializing the
 * plan-authored acceptance-test sources verbatim to disk.
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
  readonly title: string;
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

const ACCEPTANCE_HEADING_MARKER = 'Acceptance tests (plan-authored';
const IMPLEMENTATION_SENTINEL = '**Implementation:** left to the executor — no code in the plan.';

const TASK_HEADING_RE = /^###\s+Task\s+[IVXLCDM]+-\d+:.*$/gm;
const FILES_LINE_RE = /^\*\*Files:\*\*\s*(.+)$/m;
const SHELL_METACHAR_RE = /[|&;<>$`()'"]/;
const TEST_BLOCK_RE = /Path:\s*`?([^\n`]+?)`?\s*\n```[^\n]*\n([\s\S]*?)\n```\s*\nRun:\s*`?([^\n`]+?)`?\s*(?=\n|$)/g;

function stripBacktick(value: string): string {
  return value.trim().replace(/^`+|`+$/g, '').trim();
}

function extractDeclaredTestPaths(filesLine: string): string[] {
  const testIdx = filesLine.indexOf('Test:');
  if (testIdx === -1) {
    throw new ContractPlanError('malformed-plan', `Files: line is missing a "Test:" field: "${filesLine}"`);
  }
  const rest = filesLine.slice(testIdx + 'Test:'.length);
  return rest
    .split(',')
    .map(stripBacktick)
    .filter(p => p.length > 0);
}

function parseTaskSection(headingLine: string, body: string): ParsedContractTask {
  const title = headingLine.replace(/^###\s+/, '').trim();

  const filesMatch = body.match(FILES_LINE_RE);
  if (!filesMatch) {
    throw new ContractPlanError('malformed-plan', `Task "${title}" is missing an inline "**Files:**" field`);
  }
  const declaredPaths = extractDeclaredTestPaths(filesMatch[1]!);
  if (declaredPaths.length === 0) {
    throw new ContractPlanError('malformed-plan', `Task "${title}" declares no acceptance-test paths in its "Files: ... Test:" field`);
  }
  if (new Set(declaredPaths).size !== declaredPaths.length) {
    throw new ContractPlanError('malformed-plan', `Task "${title}" declares duplicate acceptance-test paths in its "Files: ... Test:" field`);
  }

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

  const acceptanceHeadingIdx = body.indexOf(ACCEPTANCE_HEADING_MARKER, cursor);
  if (acceptanceHeadingIdx === -1) {
    throw new ContractPlanError('malformed-plan', `Task "${title}" is missing the "${ACCEPTANCE_HEADING_MARKER}" acceptance-tests heading`);
  }

  const bulletContents: string[] = [];
  for (let i = 0; i < CONTRACT_BULLET_LABELS.length; i++) {
    const contentStart = bulletStarts[i]! + CONTRACT_BULLET_LABELS[i]!.length;
    const contentEnd = i < CONTRACT_BULLET_LABELS.length - 1 ? bulletStarts[i + 1]! : acceptanceHeadingIdx;
    // The last bullet's content is bounded by the acceptance-tests heading index, which can
    // leave that heading's leading "**" bold marker attached to the slice; strip it.
    bulletContents.push(body.slice(contentStart, contentEnd).trim().replace(/\*+$/, '').trim());
  }

  const implementationIdx = body.indexOf(IMPLEMENTATION_SENTINEL, acceptanceHeadingIdx);
  if (implementationIdx === -1) {
    throw new ContractPlanError('malformed-plan', `Task "${title}" is missing the exact closing line "${IMPLEMENTATION_SENTINEL}"`);
  }

  const acceptanceBlock = body.slice(acceptanceHeadingIdx, implementationIdx);

  const declaredPathHeadingCount = (acceptanceBlock.match(/^Path:/gm) ?? []).length;

  const tests: PlanAcceptanceTest[] = [];
  const seenPaths = new Set<string>();
  TEST_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEST_BLOCK_RE.exec(acceptanceBlock)) !== null) {
    const path = stripBacktick(match[1]!);
    const source = match[2]!;
    const command = stripBacktick(match[3]!);

    if (!path) {
      throw new ContractPlanError('malformed-plan', `Task "${title}" has an acceptance test with an empty "Path:"`);
    }
    if (seenPaths.has(path)) {
      throw new ContractPlanError('malformed-plan', `Task "${title}" declares duplicate acceptance test path "${path}"`);
    }
    seenPaths.add(path);

    if (!declaredPaths.includes(path)) {
      throw new ContractPlanError('malformed-plan', `Task "${title}" has acceptance test "Path: ${path}" that is not declared in its "Files: ... Test:" field`);
    }
    if (!command) {
      throw new ContractPlanError('malformed-plan', `Task "${title}" acceptance test "${path}" is missing a "Run:" command`);
    }
    if (SHELL_METACHAR_RE.test(command)) {
      throw new ContractPlanError('malformed-plan', `Task "${title}" acceptance test "${path}" has a "Run:" command containing unsafe shell metacharacters: "${command}"`);
    }

    tests.push(Object.freeze({ path, source, command }));
  }

  if (tests.length !== declaredPathHeadingCount) {
    throw new ContractPlanError('malformed-plan', `Task "${title}" has an acceptance test block with an unclosed or malformed fenced source block`);
  }

  for (const declared of declaredPaths) {
    if (!seenPaths.has(declared)) {
      throw new ContractPlanError('malformed-plan', `Task "${title}" declares "Files: ... Test: ${declared}" with no matching "Path:" acceptance test`);
    }
  }

  return Object.freeze({
    title,
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
  for (let i = 0; i < headingMatches.length; i++) {
    const heading = headingMatches[i]!;
    const start = heading.index!;
    const end = i + 1 < headingMatches.length ? headingMatches[i + 1]!.index! : markdown.length;
    const body = markdown.slice(start, end);
    const task = parseTaskSection(heading[0], body);
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

async function assertNoSymlinkAncestors(testsRoot: string, absTargetPath: string, declaredPath: string): Promise<void> {
  try {
    const testsRootStat = await lstat(testsRoot);
    if (testsRootStat.isSymbolicLink()) {
      throw new ContractPlanError('unsafe-test-path', `Acceptance test path "${declaredPath}" has a symlinked ancestor at "${testsRoot}"`);
    }
  } catch (err) {
    if (err instanceof ContractPlanError) throw err;
    // A not-yet-created tests root has no existing ancestor to inspect here.
  }

  const relFromTestsRoot = absTargetPath.slice(testsRoot.length + 1);
  const segments = relFromTestsRoot.split(sep).filter(Boolean);
  let current = testsRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new ContractPlanError('unsafe-test-path', `Acceptance test path "${declaredPath}" has a symlinked ancestor at "${current}"`);
      }
    } catch (err) {
      if (err instanceof ContractPlanError) throw err;
      // Ancestor/segment does not exist yet — nothing further to check on this branch.
      break;
    }
  }
}

export async function assertSafeAcceptanceTestPaths(snapshot: ContractPlanSnapshot, repositoryRoot: string): Promise<void> {
  const testsRoot = resolve(repositoryRoot, 'tests');
  for (const test of collectUniqueTests(snapshot)) {
    if (isAbsolute(test.path)) {
      throw new ContractPlanError('unsafe-test-path', `Acceptance test path "${test.path}" must be relative, not absolute`);
    }
    if (test.path.split(/[\\/]/).includes('..')) {
      throw new ContractPlanError('unsafe-test-path', `Acceptance test path "${test.path}" must not contain traversal segments`);
    }
    const resolved = resolve(repositoryRoot, test.path);
    if (resolved !== testsRoot && !resolved.startsWith(testsRoot + sep)) {
      throw new ContractPlanError('unsafe-test-path', `Acceptance test path "${test.path}" escapes the repository "tests" directory`);
    }
    await assertNoSymlinkAncestors(testsRoot, resolved, test.path);
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
