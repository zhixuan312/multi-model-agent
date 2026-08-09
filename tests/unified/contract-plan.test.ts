import { describe, it, expect, afterAll } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseContractPlan,
  assertSafeAcceptanceTestPaths,
  materializeAcceptanceTests,
  rematerializeAcceptanceTests,
  ContractPlanError,
} from '../../packages/core/src/unified/contract-plan.js';

// Backtick / fence placeholders — kept out of the outer template literals below so the
// literal backtick character never has to be escaped inside a `...` string.
const BT = '`';
const FENCE = '```';

const EXAMPLE_SOURCE = `import { describe, it, expect } from 'vitest';

describe('example', () => {
  it('passes', () => {
    expect(1 + 1).toBe(2);
  });
});`;

const VALID_PLAN = `
### Task I-1: Parse and validate deliverable-neutral Contract Tasks (AC-1.1)

**Output:** ${BT}packages/core/src/unified/example.ts${BT}
**Dependencies:** none

Inputs / Request: A markdown string containing one Contract Task section.

Outputs / Response: A ContractPlanSnapshot with one parsed task.

Data mapping: Each declared check's Check: path maps one-to-one to its parsed acceptance test.

Errors: Throws ContractPlanError for any structural violation.

Behavior / invariants: Parsing is pure and returns an immutable, frozen snapshot.

**Checks (plan-authored — pipeline-owned)**

Check: ${BT}tests/unified/example.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run tests/unified/example.test.ts${BT}

**Plan boundary:** final deliverable content is not in this plan.
`;

// The exact shape the `mma-plan` generator authors (plan/implement.md): `**Output:**` /
// `**Dependencies:**` metadata lines, and each declared check as `- Check:` / an INDENTED fenced
// source block / `- Run: … Expected: PASS once implemented`. This is a generator↔validator
// round-trip guard — the format mismatch that made 100% of execute_plan dispatches fail
// `malformed-plan` shipped precisely because no test parsed a realistically-generated plan (the
// fixtures were all column-0).
const GENERATED_STYLE_PLAN = `
### Task I-1: Parse and validate deliverable-neutral Contract Tasks (AC-1.1)

**Output:** ${BT}packages/core/src/unified/example.ts${BT}
**Dependencies:** none

Inputs / Request: A markdown string containing one Contract Task section.

Outputs / Response: A ContractPlanSnapshot with one parsed task.

Data mapping: Each declared check's Check: path maps one-to-one to its parsed acceptance test.

Errors: Throws ContractPlanError for any structural violation.

Behavior / invariants: Parsing is pure and returns an immutable, frozen snapshot.

**Checks (plan-authored — the executable form of the technical AC).**
- Check: ${BT}tests/unified/example.test.ts${BT}
  ${FENCE}ts
${EXAMPLE_SOURCE.split('\n').map((l) => (l.length ? '  ' + l : l)).join('\n')}
  ${FENCE}
- Run: ${BT}pnpm vitest run tests/unified/example.test.ts${BT}  Expected: PASS once implemented

**Plan boundary:** final deliverable content is not in this plan.
`;

// A task that declares no deterministic check at all — the new grammar's core addition. Absence
// of a Checks section is not an error; it simply means acceptanceTests: [].
const NO_CHECK_PLAN = `
### Task I-1: Prepare report (AC-1.1)

**Output:** ${BT}out/report.pdf${BT}
**Dependencies:** approved figures

Inputs / Request: reconciled figures.

Outputs / Response: report file.

Data mapping: figures to tables.

Errors: missing figure blocks task.

Behavior / invariants: preserve approved values.

**Plan boundary:** final deliverable content is not in this plan.
`;

const LEGACY_PLAN = `
# Feature Implementation Plan

## Phase 1: Core Setup

### 1. Add schema file

Create the schema.

### 2. Write unit tests

Test the schema.
`;

const MISSING_INPUTS_BULLET_PLAN = `
### Task I-2: A task missing its Inputs bullet (AC-2.5)

**Output:** ${BT}out/x${BT}
**Dependencies:** none

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Checks (plan-authored — pipeline-owned)**

Check: ${BT}tests/unified/missing-bullet.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run tests/unified/missing-bullet.test.ts${BT}

**Plan boundary:** final deliverable content is not in this plan.
`;

const MISSING_OUTPUT_PLAN = `
### Task I-2: A task missing its Output field (AC-2.5)

**Dependencies:** none

Inputs / Request: Something.

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Plan boundary:** final deliverable content is not in this plan.
`;

const MISSING_DEPENDENCIES_PLAN = `
### Task I-2: A task missing its Dependencies field (AC-2.5)

**Output:** ${BT}out/x${BT}

Inputs / Request: Something.

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Plan boundary:** final deliverable content is not in this plan.
`;

const MISSING_BOUNDARY_PLAN = `
### Task I-2: A task missing its Plan boundary sentinel (AC-2.5)

**Output:** ${BT}out/x${BT}
**Dependencies:** none

Inputs / Request: Something.

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.
`;

const DUPLICATE_PATH_PLAN = `
### Task I-4: Duplicate check paths (AC-1.5)

**Output:** ${BT}out/x${BT}
**Dependencies:** none

Inputs / Request: Something.

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Checks (plan-authored — pipeline-owned)**

Check: ${BT}tests/unified/dup.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run tests/unified/dup.test.ts${BT}

Check: ${BT}tests/unified/dup.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run tests/unified/dup.test.ts${BT}

**Plan boundary:** final deliverable content is not in this plan.
`;

const CROSS_TASK_DUPLICATE_PATH_PLAN = `${VALID_PLAN}

### Task I-7: A second task reusing the first task's path (AC-1.5)

**Output:** ${BT}out/x${BT}
**Dependencies:** none

Inputs / Request: Something.

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Checks (plan-authored — pipeline-owned)**

Check: ${BT}tests/unified/example.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run tests/unified/example.test.ts${BT}

**Plan boundary:** final deliverable content is not in this plan.
`;

const UNCLOSED_FENCE_PLAN = `
### Task I-5: Unclosed fenced source block (AC-1.3)

**Output:** ${BT}out/x${BT}
**Dependencies:** none

Inputs / Request: Something.

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Checks (plan-authored — pipeline-owned)**

Check: ${BT}tests/unified/unclosed.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
Run: ${BT}pnpm vitest run tests/unified/unclosed.test.ts${BT}

**Plan boundary:** final deliverable content is not in this plan.
`;

const UNSAFE_RUN_COMMAND_PLAN = `
### Task I-6: A Run command with shell metacharacters (AC-1.3)

**Output:** ${BT}out/x${BT}
**Dependencies:** none

Inputs / Request: Something.

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Checks (plan-authored — pipeline-owned)**

Check: ${BT}tests/unified/unsafe-run.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run tests/unified/unsafe-run.test.ts && rm -rf /${BT}

**Plan boundary:** final deliverable content is not in this plan.
`;

const EMPTY_CHECKS_SECTION_PLAN = `
### Task I-8: A Checks heading with no entries (AC-1.3)

**Output:** ${BT}out/x${BT}
**Dependencies:** none

Inputs / Request: Something.

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Checks (plan-authored — pipeline-owned)**

**Plan boundary:** final deliverable content is not in this plan.
`;

function expectContractPlanError(fn: () => unknown, code: ContractPlanError['code']) {
  try {
    fn();
    throw new Error('expected ContractPlanError to be thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(ContractPlanError);
    expect((err as ContractPlanError).code).toBe(code);
    expect((err as ContractPlanError).message.length).toBeGreaterThan(0);
  }
}

describe('parseContractPlan', () => {
  it('parses one valid Contract Task with a declared check', () => {
    const snapshot = parseContractPlan(VALID_PLAN);

    expect(snapshot.tasks.length).toBe(1);
    const task = snapshot.tasks[0]!;
    expect(task.title).toBe('Task I-1: Parse and validate deliverable-neutral Contract Tasks (AC-1.1)');
    expect(task.output).toBe('`packages/core/src/unified/example.ts`');
    expect(task.dependencies).toBe('none');
    expect(task.acceptanceTests.length).toBe(1);
    expect(task.acceptanceTests[0]).toEqual({
      path: 'tests/unified/example.test.ts',
      source: EXAMPLE_SOURCE,
      command: 'pnpm vitest run tests/unified/example.test.ts',
    });
  });

  it('returns a byte-for-byte source string', () => {
    const snapshot = parseContractPlan(VALID_PLAN);
    expect(snapshot.tasks[0]!.acceptanceTests[0]!.source).toBe(EXAMPLE_SOURCE);
  });

  it('parses a plan authored in the mma-plan generator format (bulleted Check/Run, indented fence, trailing prose)', () => {
    const snapshot = parseContractPlan(GENERATED_STYLE_PLAN);
    expect(snapshot.tasks.length).toBe(1);
    const at = snapshot.tasks[0]!.acceptanceTests[0]!;
    expect(at.path).toBe('tests/unified/example.test.ts');
    // trailing "Expected: PASS once implemented" is stripped from the command
    expect(at.command).toBe('pnpm vitest run tests/unified/example.test.ts');
    // the 2-space fence indentation is removed → source round-trips byte-for-byte to the original
    // (EXAMPLE_SOURCE keeps its own inner indentation like `  it(...)`; only the fence indent is stripped)
    expect(at.source).toBe(EXAMPLE_SOURCE);
  });

  it('accepts a task that declares no deterministic check at all', () => {
    const snapshot = parseContractPlan(NO_CHECK_PLAN);
    expect(snapshot.tasks.length).toBe(1);
    const task = snapshot.tasks[0]!;
    expect(task.id).toBe('I-1');
    expect(task.output).toBe('`out/report.pdf`');
    expect(task.dependencies).toBe('approved figures');
    expect(task.acceptanceTests).toEqual([]);
  });

  it('tolerates a human-facing Technical acceptance criteria line before the Contract', () => {
    // The human-executable plan template adds a "**Technical acceptance criteria**" line between
    // the Output/Dependencies metadata and the Contract bullets. It is for humans; the parser
    // must ignore it and still extract the same contract + acceptance test.
    const withTechAc = VALID_PLAN.replace(
      '\nInputs / Request:',
      '\n**Technical acceptance criteria** (← AC-1.1): Given a valid markdown task, one snapshot is returned.\n\nInputs / Request:',
    );
    const snapshot = parseContractPlan(withTechAc);
    expect(snapshot.tasks.length).toBe(1);
    expect(snapshot.tasks[0]!.acceptanceTests[0]).toEqual({
      path: 'tests/unified/example.test.ts',
      source: EXAMPLE_SOURCE,
      command: 'pnpm vitest run tests/unified/example.test.ts',
    });
    // The Technical-AC prose is NOT absorbed into the last Contract bullet.
    expect(snapshot.tasks[0]!.contract.behaviorInvariants).not.toContain('Technical acceptance criteria');
  });

  it('returns an immutable deep-frozen snapshot', () => {
    const snapshot = parseContractPlan(VALID_PLAN);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tasks)).toBe(true);
    expect(Object.isFrozen(snapshot.tasks[0])).toBe(true);
    expect(Object.isFrozen(snapshot.tasks[0]!.contract)).toBe(true);
    expect(Object.isFrozen(snapshot.tasks[0]!.acceptanceTests)).toBe(true);
    expect(Object.isFrozen(snapshot.tasks[0]!.acceptanceTests[0])).toBe(true);
  });

  it('rejects a legacy plan with no Task sections as unsupported-legacy-plan', () => {
    expectContractPlanError(() => parseContractPlan(LEGACY_PLAN), 'unsupported-legacy-plan');
  });

  it('rejects a task missing the "Inputs / Request:" bullet as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(MISSING_INPUTS_BULLET_PLAN), 'malformed-plan');
  });

  it('rejects a task missing its "**Output:**" declaration as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(MISSING_OUTPUT_PLAN), 'malformed-plan');
  });

  it('rejects a task missing its "**Dependencies:**" declaration as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(MISSING_DEPENDENCIES_PLAN), 'malformed-plan');
  });

  it('rejects a task missing the "**Plan boundary:**" sentinel as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(MISSING_BOUNDARY_PLAN), 'malformed-plan');
  });

  it('rejects duplicate check paths within one task as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(DUPLICATE_PATH_PLAN), 'malformed-plan');
  });

  it('rejects check paths duplicated across Contract Tasks as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(CROSS_TASK_DUPLICATE_PATH_PLAN), 'malformed-plan');
  });

  it('rejects an unclosed fenced source block as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(UNCLOSED_FENCE_PLAN), 'malformed-plan');
  });

  it('rejects a Run: command containing shell metacharacters as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(UNSAFE_RUN_COMMAND_PLAN), 'malformed-plan');
  });

  it('rejects a Checks heading that names no check entries as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(EMPTY_CHECKS_SECTION_PLAN), 'malformed-plan');
  });
});

describe('assertSafeAcceptanceTestPaths', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'mma-contract-plan-safety-'));
  afterAll(() => rmSync(tmpBase, { recursive: true, force: true }));

  function snapshotWithPath(path: string) {
    return {
      tasks: [
        {
          title: 'Task I-9: safety fixture',
          output: 'out/x',
          dependencies: 'none',
          contract: {
            inputsRequest: '',
            outputsResponse: '',
            dataMapping: '',
            errors: '',
            behaviorInvariants: '',
          },
          acceptanceTests: [{ path, source: EXAMPLE_SOURCE, command: 'pnpm vitest run x' }],
        },
      ],
    };
  }

  it('rejects a traversal path escaping the tests directory as unsafe-test-path', async () => {
    const repoRoot = join(tmpBase, 'traversal-repo');
    mkdirSync(join(repoRoot, 'tests'), { recursive: true });
    await expect(
      assertSafeAcceptanceTestPaths(snapshotWithPath('../escape.test.ts'), repoRoot),
    ).rejects.toMatchObject({ code: 'unsafe-test-path' });
  });

  it('rejects a traversal path even when normalization would keep it beneath tests', async () => {
    const repoRoot = join(tmpBase, 'normalized-traversal-repo');
    mkdirSync(join(repoRoot, 'tests'), { recursive: true });
    await expect(
      assertSafeAcceptanceTestPaths(snapshotWithPath('tests/unified/../escape.test.ts'), repoRoot),
    ).rejects.toMatchObject({ code: 'unsafe-test-path' });
  });

  it('rejects an absolute path as unsafe-test-path', async () => {
    const repoRoot = join(tmpBase, 'absolute-repo');
    mkdirSync(join(repoRoot, 'tests'), { recursive: true });
    await expect(
      assertSafeAcceptanceTestPaths(snapshotWithPath('/absolute.test.ts'), repoRoot),
    ).rejects.toMatchObject({ code: 'unsafe-test-path' });
  });

  it('rejects a path with a symlinked ancestor as unsafe-test-path', async () => {
    const repoRoot = join(tmpBase, 'symlink-repo');
    mkdirSync(join(repoRoot, 'tests', 'real-target'), { recursive: true });
    symlinkSync(join(repoRoot, 'tests', 'real-target'), join(repoRoot, 'tests', 'link'));

    await expect(
      assertSafeAcceptanceTestPaths(snapshotWithPath('tests/link/file.test.ts'), repoRoot),
    ).rejects.toMatchObject({ code: 'unsafe-test-path' });
  });

  it('rejects a symlinked tests directory as unsafe-test-path', async () => {
    const repoRoot = join(tmpBase, 'symlink-tests-root-repo');
    mkdirSync(join(repoRoot, 'real-tests'), { recursive: true });
    symlinkSync(join(repoRoot, 'real-tests'), join(repoRoot, 'tests'));

    await expect(
      assertSafeAcceptanceTestPaths(snapshotWithPath('tests/unified/file.test.ts'), repoRoot),
    ).rejects.toMatchObject({ code: 'unsafe-test-path' });
  });

  it('accepts a safe path canonically beneath the tests directory', async () => {
    const repoRoot = join(tmpBase, 'safe-repo');
    mkdirSync(join(repoRoot, 'tests'), { recursive: true });
    await expect(
      assertSafeAcceptanceTestPaths(snapshotWithPath('tests/unified/safe.test.ts'), repoRoot),
    ).resolves.toBeUndefined();
  });
});

describe('materializeAcceptanceTests / rematerializeAcceptanceTests', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'mma-contract-plan-materialize-'));
  afterAll(() => rmSync(tmpBase, { recursive: true, force: true }));

  function snapshotWithTests(entries: Array<{ path: string; source: string }>) {
    return {
      tasks: [
        {
          title: 'Task I-10: materialize fixture',
          output: 'out/x',
          dependencies: 'none',
          contract: {
            inputsRequest: '',
            outputsResponse: '',
            dataMapping: '',
            errors: '',
            behaviorInvariants: '',
          },
          acceptanceTests: entries.map(e => ({ ...e, command: 'pnpm vitest run x' })),
        },
      ],
    };
  }

  it('materializes a new acceptance test file verbatim', async () => {
    const repoRoot = join(tmpBase, 'new-repo');
    mkdirSync(join(repoRoot, 'tests'), { recursive: true });
    const snapshot = snapshotWithTests([{ path: 'tests/unified/new-file.test.ts', source: EXAMPLE_SOURCE }]);

    await materializeAcceptanceTests(snapshot, repoRoot);

    const written = readFileSync(join(repoRoot, 'tests/unified/new-file.test.ts'), 'utf8');
    expect(written).toBe(EXAMPLE_SOURCE);
  });

  it('refuses to overwrite an existing acceptance test path as test-path-collision, leaving its bytes unchanged', async () => {
    const repoRoot = join(tmpBase, 'collision-repo');
    mkdirSync(join(repoRoot, 'tests', 'unified'), { recursive: true });
    writeFileSync(join(repoRoot, 'tests/unified/existing.test.ts'), 'pre-existing bytes');

    const snapshot = snapshotWithTests([
      { path: 'tests/unified/existing.test.ts', source: EXAMPLE_SOURCE },
      { path: 'tests/unified/sibling.test.ts', source: EXAMPLE_SOURCE },
    ]);

    await expect(materializeAcceptanceTests(snapshot, repoRoot)).rejects.toMatchObject({
      code: 'test-path-collision',
    });

    expect(readFileSync(join(repoRoot, 'tests/unified/existing.test.ts'), 'utf8')).toBe('pre-existing bytes');
    expect(existsSync(join(repoRoot, 'tests/unified/sibling.test.ts'))).toBe(false);
  });

  it('rematerializes a previously materialized file, overwriting it with the snapshot bytes', async () => {
    const repoRoot = join(tmpBase, 'rematerialize-repo');
    mkdirSync(join(repoRoot, 'tests'), { recursive: true });
    const snapshot = snapshotWithTests([{ path: 'tests/unified/rewrite.test.ts', source: EXAMPLE_SOURCE }]);

    await materializeAcceptanceTests(snapshot, repoRoot);
    writeFileSync(join(repoRoot, 'tests/unified/rewrite.test.ts'), 'implementer edited this file');

    await rematerializeAcceptanceTests(snapshot, repoRoot);

    expect(readFileSync(join(repoRoot, 'tests/unified/rewrite.test.ts'), 'utf8')).toBe(EXAMPLE_SOURCE);
  });
});
