import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../../contract/fixtures/harness.js';
import { mockProvider } from '../../contract/fixtures/mock-providers.js';
import { getTypeConfig, oppositeAgent } from '@zhixuan92/multi-model-agent-core';

const HEADERS = (token: string) => ({
  'Content-Type': 'application/json',
  'X-MMA-Main-Model': 'claude-opus-4-8',
  'X-MMA-Client': 'claude-code',
  Authorization: `Bearer ${token}`,
});

async function dispatch(h: { baseUrl: string; token: string }, cwd: string, body: object) {
  return fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(cwd)}`, {
    method: 'POST', headers: HEADERS(h.token), body: JSON.stringify(body),
  });
}

async function pollToTerminal(h: { baseUrl: string; token: string }, taskId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`${h.baseUrl}/task/${taskId}`, { headers: HEADERS(h.token) });
    if (res.status === 200) return (await res.json()) as Record<string, unknown>;
    if (res.status !== 202) throw new Error(`Unexpected ${res.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
}

const TASK_TITLE = 'Task I-1: reject invalid dispatch';

/** Build a valid frozen Contract Task section body (everything after the heading line
 *  up to and including the "**Implementation:**" sentinel). Each `overrides` entry lets
 *  a test corrupt exactly one clause to exercise a specific malformed-plan branch. */
function contractTaskLines(testPath: string, overrides: Partial<{
  filesLine: string;
  bullets: string[];
  acceptanceHeading: string;
  pathLine: string;
  fenceOpen: string;
  fenceClose: string;
  runLine: string;
  implementationSentinel: string;
}> = {}): string[] {
  const bullets = overrides.bullets ?? [
    'Inputs / Request: a valid request',
    'Outputs / Response: a valid response',
    'Data mapping: none',
    'Errors: none',
    'Behavior / invariants: none',
  ];
  const lines = [
    `### ${TASK_TITLE}`,
    '',
    overrides.filesLine ?? `**Files:** Test: ${testPath}`,
    '',
    ...bullets,
    '',
    overrides.acceptanceHeading ?? 'Acceptance tests (plan-authored):',
    '',
    overrides.pathLine ?? `Path: \`${testPath}\``,
    overrides.fenceOpen ?? '```ts',
    "it('passes', () => { expect(1).toBe(1); });",
  ];
  if (overrides.fenceClose !== '') lines.push(overrides.fenceClose ?? '```');
  lines.push(
    overrides.runLine ?? 'Run: `true`',
    '',
    overrides.implementationSentinel ?? '**Implementation:** left to the executor — no code in the plan.',
    '',
  );
  return lines;
}

function validPlanText(testPath: string): string {
  return ['# Contract-first plan fixture', '', ...contractTaskLines(testPath)].join('\n');
}

async function writePlan(dir: string, text: string): Promise<string> {
  const planPath = join(dir, 'plan.md');
  await writeFile(planPath, text, 'utf8');
  return planPath;
}

interface DispatchOutcome {
  taskId: string;
  env: Record<string, unknown>;
  opens: number;
}

/** Dispatch execute_plan against `planText` in a fresh tmp cwd and poll to terminal. */
async function runExecutePlan(planText: string, tasksSelector: string[] = []): Promise<DispatchOutcome> {
  const tmp = await mkdtemp(join(tmpdir(), 'mma-ep-'));
  await writePlan(tmp, planText);
  let opens = 0;
  const h = await boot({
    provider: mockProvider({
      sequence: [
        { output: 'implemented' },
        { output: JSON.stringify({ tasks: [{ title: TASK_TITLE, status: 'done' }], notes: '' }) },
      ],
      onOpen: () => { opens += 1; },
    }),
    cwd: tmp,
  });
  try {
    const res = await dispatch(h, tmp, { type: 'execute_plan', target: { paths: ['plan.md'] }, tasks: tasksSelector });
    expect(res.status).toBe(202);
    const { taskId } = (await res.json()) as { taskId: string };
    const env = await pollToTerminal(h, taskId);
    return { taskId, env, opens };
  } finally {
    await h.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

describe('execute_plan contract-first dispatch validation', () => {
  it('dispatches a valid frozen Contract Task plan to the provider', async () => {
    const testPath = 'tests/unified/contract-first-fixture-valid.test.ts';
    const tmp = await mkdtemp(join(tmpdir(), 'mma-ep-valid-'));
    await writePlan(tmp, validPlanText(testPath));
    const prompts: string[] = [];
    let opens = 0;
    const h = await boot({
      provider: mockProvider({
        sequence: [
          { output: 'implemented' },
          { output: JSON.stringify({ tasks: [{ title: TASK_TITLE, status: 'done' }], notes: '' }) },
        ],
        onPrompt: (p) => prompts.push(p),
        onOpen: () => { opens += 1; },
      }),
      cwd: tmp,
    });
    try {
      const res = await dispatch(h, tmp, { type: 'execute_plan', target: { paths: ['plan.md'] } });
      expect(res.status).toBe(202);
      const { taskId } = (await res.json()) as { taskId: string };
      const env = await pollToTerminal(h, taskId);
      expect((env.task as Record<string, unknown>).status).not.toBe('failed');
      expect(opens).toBeGreaterThan(0);
      // The reviewer prompt gets the Dispatched Tasks completeness section, naming
      // this Contract Task by its exact title selected from parseContractPlan.
      expect(prompts.some((p) => p.includes(TASK_TITLE))).toBe(true);
    } finally {
      await h.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a legacy (non-frozen) plan as unsupported-legacy-plan before any session opens', async () => {
    const legacyPlan = '# Legacy plan\n\n### Task 1: legacy heading\n\n- [ ] Step 1: do something\n';
    const { env, opens } = await runExecutePlan(legacyPlan);
    expect((env.task as Record<string, unknown>).status).toBe('failed');
    expect((env.error as Record<string, unknown>).code).toBe('unsupported-legacy-plan');
    expect(opens).toBe(0);
  });

  it('rejects a Contract Task missing a required Contract bullet as malformed-plan', async () => {
    const planText = ['# Plan', '', ...contractTaskLines('tests/unified/x.test.ts', {
      bullets: [
        'Inputs / Request: a valid request',
        'Outputs / Response: a valid response',
        'Data mapping: none',
        // "Errors:" bullet omitted
        'Behavior / invariants: none',
      ],
    })].join('\n');
    const { env, opens } = await runExecutePlan(planText);
    expect((env.task as Record<string, unknown>).status).toBe('failed');
    expect((env.error as Record<string, unknown>).code).toBe('malformed-plan');
    expect(opens).toBe(0);
  });

  it('rejects an acceptance test Path not declared in Files: ... Test: as malformed-plan', async () => {
    const planText = ['# Plan', '', ...contractTaskLines('tests/unified/declared.test.ts', {
      pathLine: 'Path: `tests/unified/different.test.ts`',
    })].join('\n');
    const { env, opens } = await runExecutePlan(planText);
    expect((env.task as Record<string, unknown>).status).toBe('failed');
    expect((env.error as Record<string, unknown>).code).toBe('malformed-plan');
    expect(opens).toBe(0);
  });

  it('rejects duplicate acceptance-test paths in Files: ... Test: as malformed-plan', async () => {
    const testPath = 'tests/unified/dup.test.ts';
    const planText = ['# Plan', '', ...contractTaskLines(testPath, {
      filesLine: `**Files:** Test: ${testPath}, ${testPath}`,
    })].join('\n');
    const { env, opens } = await runExecutePlan(planText);
    expect((env.task as Record<string, unknown>).status).toBe('failed');
    expect((env.error as Record<string, unknown>).code).toBe('malformed-plan');
    expect(opens).toBe(0);
  });

  it('rejects an unclosed fenced source block as malformed-plan', async () => {
    const planText = ['# Plan', '', ...contractTaskLines('tests/unified/unclosed.test.ts', {
      fenceClose: '',
    })].join('\n');
    const { env, opens } = await runExecutePlan(planText);
    expect((env.task as Record<string, unknown>).status).toBe('failed');
    expect((env.error as Record<string, unknown>).code).toBe('malformed-plan');
    expect(opens).toBe(0);
  });

  it('rejects a dispatch whose acceptance-test path already exists, leaving the file unchanged', async () => {
    const testPath = 'tests/unified/pre-existing.test.ts';
    const tmp = await mkdtemp(join(tmpdir(), 'mma-ep-collision-'));
    const existingAbs = join(tmp, testPath);
    await mkdir(join(tmp, 'tests', 'unified'), { recursive: true });
    const originalBytes = "it('original', () => { expect(true).toBe(true); });\n";
    await writeFile(existingAbs, originalBytes, 'utf8');
    await writePlan(tmp, validPlanText(testPath));
    let opens = 0;
    const h = await boot({
      provider: mockProvider({
        sequence: [{ output: 'implemented' }, { output: '{}' }],
        onOpen: () => { opens += 1; },
      }),
      cwd: tmp,
    });
    try {
      const res = await dispatch(h, tmp, { type: 'execute_plan', target: { paths: ['plan.md'] } });
      const { taskId } = (await res.json()) as { taskId: string };
      const env = await pollToTerminal(h, taskId);
      expect((env.task as Record<string, unknown>).status).toBe('failed');
      expect((env.error as Record<string, unknown>).code).toBe('test-path-collision');
      expect(opens).toBe(0);
      const afterBytes = await readFile(existingAbs, 'utf8');
      expect(afterBytes).toBe(originalBytes);
    } finally {
      await h.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects an acceptance-test path with a traversal segment as unsafe-test-path', async () => {
    const planText = ['# Plan', '', ...contractTaskLines('tests/unified/../escape.test.ts')].join('\n');
    const { env, opens } = await runExecutePlan(planText);
    expect((env.task as Record<string, unknown>).status).toBe('failed');
    expect((env.error as Record<string, unknown>).code).toBe('unsafe-test-path');
    expect(opens).toBe(0);
  });

  it('rejects an acceptance-test path behind a symlinked ancestor as unsafe-test-path', async () => {
    const testPath = 'tests/linked/via-symlink.test.ts';
    const tmp = await mkdtemp(join(tmpdir(), 'mma-ep-symlink-'));
    const realTarget = join(tmp, 'real-target-dir');
    await mkdir(realTarget, { recursive: true });
    await mkdir(join(tmp, 'tests'), { recursive: true });
    await symlink(realTarget, join(tmp, 'tests', 'linked'), 'dir');
    await writePlan(tmp, validPlanText(testPath));
    let opens = 0;
    const h = await boot({
      provider: mockProvider({
        sequence: [{ output: 'implemented' }, { output: '{}' }],
        onOpen: () => { opens += 1; },
      }),
      cwd: tmp,
    });
    try {
      const res = await dispatch(h, tmp, { type: 'execute_plan', target: { paths: ['plan.md'] } });
      const { taskId } = (await res.json()) as { taskId: string };
      const env = await pollToTerminal(h, taskId);
      expect((env.task as Record<string, unknown>).status).toBe('failed');
      expect((env.error as Record<string, unknown>).code).toBe('unsafe-test-path');
      expect(opens).toBe(0);
    } finally {
      await h.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('fails a dispatch requesting an unknown task selector without opening a provider session', async () => {
    const planText = validPlanText('tests/unified/selector.test.ts');
    const { env, opens } = await runExecutePlan(planText, ['Task I-99: does not exist']);
    expect((env.task as Record<string, unknown>).status).toBe('failed');
    expect((env.error as Record<string, unknown>).code).toBe('no_match');
    expect(opens).toBe(0);
  });

  it('keeps oppositeAgent tier separation unchanged for execute_plan and plan', () => {
    // Regression guard: contract-first dispatch validation must not touch type-registry.ts.
    // execute_plan dispatches standard (implementer) -> complex (reviewer); plan dispatches
    // complex (implementer) -> standard (reviewer).
    const executePlanTier = getTypeConfig('execute_plan').defaultTier;
    expect(executePlanTier).toBe('standard');
    expect(oppositeAgent(executePlanTier)).toBe('complex');

    const planTier = getTypeConfig('plan').defaultTier;
    expect(planTier).toBe('complex');
    expect(oppositeAgent(planTier)).toBe('standard');
  });

  it('dispatches a valid execute_plan end to end without touching tier selection', async () => {
    const testPath = 'tests/unified/tiers-e2e.test.ts';
    const tmp = await mkdtemp(join(tmpdir(), 'mma-ep-tiers-'));
    await writePlan(tmp, validPlanText(testPath));
    const h = await boot({
      provider: mockProvider({
        sequence: [
          { output: 'implemented' },
          { output: JSON.stringify({ tasks: [{ title: TASK_TITLE, status: 'done' }], notes: '' }) },
        ],
      }),
      cwd: tmp,
    });
    try {
      const res = await dispatch(h, tmp, { type: 'execute_plan', target: { paths: ['plan.md'] } });
      const { taskId } = (await res.json()) as { taskId: string };
      const env = await pollToTerminal(h, taskId);
      expect((env.task as Record<string, unknown>).status).not.toBe('failed');
    } finally {
      await h.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
