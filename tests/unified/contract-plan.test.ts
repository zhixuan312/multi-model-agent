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
### Task I-1: Parse and validate frozen Contract Tasks (AC-1.1)

**Files:** Modify: ${BT}packages/core/src/unified/example.ts${BT} — Test: ${BT}tests/unified/example.test.ts${BT}

Inputs / Request: A markdown string containing one frozen Contract Task section.

Outputs / Response: A ContractPlanSnapshot with one parsed task.

Data mapping: The Files: ... Test: path maps one-to-one to the Path: acceptance-test entry.

Errors: Throws ContractPlanError for any structural violation.

Behavior / invariants: Parsing is pure and returns an immutable, frozen snapshot.

**Acceptance tests (plan-authored — pipeline-owned)**

Path: ${BT}tests/unified/example.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run tests/unified/example.test.ts${BT}

**Implementation:** left to the executor — no code in the plan.
`;

// The exact shape the `mma-plan` generator authors (plan/implement.md): a multi-line **Files:** bullet
// list, and each acceptance test as `- Path:` / an INDENTED fenced source block / `- Run: … Expected:
// PASS once implemented`. This is a generator↔validator round-trip guard — the format mismatch that
// made 100% of execute_plan dispatches fail `malformed-plan` shipped precisely because no test parsed
// a realistically-generated plan (the fixtures were all column-0).
const GENERATED_STYLE_PLAN = `
### Task I-1: Parse and validate frozen Contract Tasks (AC-1.1)

**Files:**
- Modify: ${BT}packages/core/src/unified/example.ts${BT}
- Test: ${BT}tests/unified/example.test.ts${BT}

Inputs / Request: A markdown string containing one frozen Contract Task section.

Outputs / Response: A ContractPlanSnapshot with one parsed task.

Data mapping: The Files: ... Test: path maps one-to-one to the Path: acceptance-test entry.

Errors: Throws ContractPlanError for any structural violation.

Behavior / invariants: Parsing is pure and returns an immutable, frozen snapshot.

**Acceptance tests (plan-authored — the executable form of the technical AC).**
- Path: ${BT}tests/unified/example.test.ts${BT}
  ${FENCE}ts
${EXAMPLE_SOURCE.split('\n').map((l) => (l.length ? '  ' + l : l)).join('\n')}
  ${FENCE}
- Run: ${BT}pnpm vitest run tests/unified/example.test.ts${BT}  Expected: PASS once implemented

**Implementation:** left to the executor — no code in the plan.
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

**Files:** Test: ${BT}tests/unified/missing-bullet.test.ts${BT}

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Acceptance tests (plan-authored — pipeline-owned)**

Path: ${BT}tests/unified/missing-bullet.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run tests/unified/missing-bullet.test.ts${BT}

**Implementation:** left to the executor — no code in the plan.
`;

const PATH_NOT_DECLARED_PLAN = `
### Task I-3: A Path not declared in Files Test (AC-1.5)

**Files:** Test: ${BT}tests/unified/declared.test.ts${BT}

Inputs / Request: Something.

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Acceptance tests (plan-authored — pipeline-owned)**

Path: ${BT}tests/unified/undeclared.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run tests/unified/undeclared.test.ts${BT}

**Implementation:** left to the executor — no code in the plan.
`;

const DUPLICATE_PATH_PLAN = `
### Task I-4: Duplicate acceptance test paths (AC-1.5)

**Files:** Test: ${BT}tests/unified/dup.test.ts${BT}, ${BT}tests/unified/dup2.test.ts${BT}

Inputs / Request: Something.

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Acceptance tests (plan-authored — pipeline-owned)**

Path: ${BT}tests/unified/dup.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run tests/unified/dup.test.ts${BT}

Path: ${BT}tests/unified/dup.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run tests/unified/dup.test.ts${BT}

**Implementation:** left to the executor — no code in the plan.
`;

const CROSS_TASK_DUPLICATE_PATH_PLAN = `${VALID_PLAN}

### Task I-7: A second task reusing the first task's path (AC-1.5)

**Files:** Test: ${BT}tests/unified/example.test.ts${BT}

Inputs / Request: Something.

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Acceptance tests (plan-authored — pipeline-owned)**

Path: ${BT}tests/unified/example.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run tests/unified/example.test.ts${BT}

**Implementation:** left to the executor — no code in the plan.
`;

const UNCLOSED_FENCE_PLAN = `
### Task I-5: Unclosed fenced source block (AC-1.3)

**Files:** Test: ${BT}tests/unified/unclosed.test.ts${BT}

Inputs / Request: Something.

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Acceptance tests (plan-authored — pipeline-owned)**

Path: ${BT}tests/unified/unclosed.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
Run: ${BT}pnpm vitest run tests/unified/unclosed.test.ts${BT}

**Implementation:** left to the executor — no code in the plan.
`;

const UNSAFE_RUN_COMMAND_PLAN = `
### Task I-6: A Run command with shell metacharacters (AC-1.3)

**Files:** Test: ${BT}tests/unified/unsafe-run.test.ts${BT}

Inputs / Request: Something.

Outputs / Response: Something.

Data mapping: Something.

Errors: Something.

Behavior / invariants: Something.

**Acceptance tests (plan-authored — pipeline-owned)**

Path: ${BT}tests/unified/unsafe-run.test.ts${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run tests/unified/unsafe-run.test.ts && rm -rf /${BT}

**Implementation:** left to the executor — no code in the plan.
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
  it('parses one valid frozen Contract Task', () => {
    const snapshot = parseContractPlan(VALID_PLAN);

    expect(snapshot.tasks.length).toBe(1);
    const task = snapshot.tasks[0]!;
    expect(task.title).toBe('Task I-1: Parse and validate frozen Contract Tasks (AC-1.1)');
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

  it('parses a plan authored in the mma-plan generator format (bulleted Files/Path/Run, indented fence, trailing prose)', () => {
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

  it('accepts the Forge-style multi-line **Files:** bullet list (not just the inline form)', () => {
    // Forge renders task files from a multi-line `**Files:**\n- Create/Test: \`path\`` list; the
    // executor parser must accept that same shape so one plan loads in Forge AND runs here.
    const multiline = VALID_PLAN.replace(
      /\*\*Files:\*\*.*/,
      '**Files:**\n- Modify: ' + BT + 'packages/core/src/unified/example.ts' + BT + '\n- Test: ' + BT + 'tests/unified/example.test.ts' + BT,
    );
    const snapshot = parseContractPlan(multiline);
    expect(snapshot.tasks.length).toBe(1);
    expect(snapshot.tasks[0]!.acceptanceTests[0]!.path).toBe('tests/unified/example.test.ts');
  });

  it('tolerates a human-facing Technical acceptance criteria line before the Contract', () => {
    // The human-executable plan template adds a "**Technical acceptance criteria**" line between
    // **Files:** and the Contract bullets. It is for humans; the parser must ignore it and still
    // extract the same contract + acceptance test.
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

  it('rejects a legacy plan with no frozen Task sections as unsupported-legacy-plan', () => {
    expectContractPlanError(() => parseContractPlan(LEGACY_PLAN), 'unsupported-legacy-plan');
  });

  it('rejects a task missing the "Inputs / Request:" bullet as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(MISSING_INPUTS_BULLET_PLAN), 'malformed-plan');
  });

  it('rejects a Path: absent from the Files: ... Test: field as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(PATH_NOT_DECLARED_PLAN), 'malformed-plan');
  });

  it('rejects duplicate acceptance test paths as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(DUPLICATE_PATH_PLAN), 'malformed-plan');
  });

  it('rejects acceptance test paths duplicated across Contract Tasks as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(CROSS_TASK_DUPLICATE_PATH_PLAN), 'malformed-plan');
  });

  it('rejects an unclosed fenced source block as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(UNCLOSED_FENCE_PLAN), 'malformed-plan');
  });

  it('rejects a Run: command containing shell metacharacters as malformed-plan', () => {
    expectContractPlanError(() => parseContractPlan(UNSAFE_RUN_COMMAND_PLAN), 'malformed-plan');
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
