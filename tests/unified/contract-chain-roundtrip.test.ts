import { describe, it, expect } from 'vitest';
import { parseContractPlan } from '../../packages/core/src/unified/contract-plan.js';
import {
  dispatchedTasksFromSnapshot,
  contractMatchFromReviewer,
  resolveSelectors,
  describeSelectorFailure,
  extractTaskId,
} from '../../packages/core/src/unified/contract-match.js';

/**
 * FR-10 — round-trip guard for the WHOLE contract chain:
 *
 *   mma-plan headings → parseContractPlan → dispatched tasks → reviewer echo → validation
 *
 * The 5.15.0-era regressions all shipped because each boundary was tested against a
 * cooperating counterpart: the existing matcher test fed the validator a reviewer echo that
 * already matched byte-for-byte, so the mismatch case never fired. This test deliberately
 * makes the reviewer UNCOOPERATIVE — it paraphrases titles, drops the `(← AC-…)` annotation,
 * and reorders entries — while keeping the stable task IDs correct. That is exactly what a
 * real LLM reviewer does, and it must not be read as "the work isn't done".
 */

const BT = '`';
const FENCE = '```';

const EXAMPLE_SOURCE = `import { describe, it, expect } from 'vitest';

describe('example', () => {
  it('passes', () => {
    expect(1 + 1).toBe(2);
  });
});`;

function task(id: string, title: string, testPath: string): string {
  return `
### Task ${id}: ${title}

**Files:** Modify: ${BT}packages/core/src/unified/example.ts${BT} — Test: ${BT}${testPath}${BT}

Inputs / Request: A markdown string containing one frozen Contract Task section.

Outputs / Response: A ContractPlanSnapshot with the parsed task.

Data mapping: The Files: ... Test: path maps one-to-one to the Path: acceptance-test entry.

Errors: Throws ContractPlanError for any structural violation.

Behavior / invariants: Parsing is pure and returns an immutable, frozen snapshot.

**Acceptance tests (plan-authored — pipeline-owned)**

Path: ${BT}${testPath}${BT}
${FENCE}ts
${EXAMPLE_SOURCE}
${FENCE}
Run: ${BT}pnpm vitest run ${testPath}${BT}

**Implementation:** left to the executor — no code in the plan.
`;
}

const PLAN = [
  task('I-1', 'Parse and validate frozen Contract Tasks (← AC-1.1)', 'tests/unified/a.test.ts'),
  task('I-2', 'Derive dispatched task identities (← AC-1.2)', 'tests/unified/b.test.ts'),
].join('\n');

describe('contract chain round-trip', () => {
  it('parses stable task IDs out of the plan headings', () => {
    const snapshot = parseContractPlan(PLAN);
    expect(snapshot.tasks.map(t => t.id)).toEqual(['I-1', 'I-2']);
  });

  it('carries id AND title through to the dispatched task records', () => {
    const dispatched = dispatchedTasksFromSnapshot(parseContractPlan(PLAN));
    expect(dispatched).toEqual([
      { id: 'I-1', title: 'Task I-1: Parse and validate frozen Contract Tasks (← AC-1.1)' },
      { id: 'I-2', title: 'Task I-2: Derive dispatched task identities (← AC-1.2)' },
    ]);
  });

  // THE case the old suite never exercised.
  it('matches when the reviewer paraphrases every title but keeps the IDs', () => {
    const dispatched = dispatchedTasksFromSnapshot(parseContractPlan(PLAN));
    const reviewer = {
      tasks: [
        { id: 'I-2', title: 'derived the identities', status: 'done' },
        { id: 'I-1', title: 'parsing + validation of contract tasks', status: 'done' },
      ],
    };
    const result = contractMatchFromReviewer(reviewer, dispatched);
    expect(result.matched).toBe(true);
    expect(result.allDone).toBe(true);
  });

  it('still matches when the reviewer omits titles entirely', () => {
    const dispatched = dispatchedTasksFromSnapshot(parseContractPlan(PLAN));
    const result = contractMatchFromReviewer(
      { tasks: [{ id: 'I-1', status: 'done' }, { id: 'I-2', status: 'done' }] },
      dispatched,
    );
    expect(result.matched).toBe(true);
    expect(result.allDone).toBe(true);
  });

  it('would FAIL if title equality were reintroduced — identical IDs, wholly different titles', () => {
    const dispatched = dispatchedTasksFromSnapshot(parseContractPlan(PLAN));
    const result = contractMatchFromReviewer(
      {
        tasks: [
          { id: 'I-1', title: 'COMPLETELY UNRELATED TEXT', status: 'done' },
          { id: 'I-2', title: 'ALSO UNRELATED', status: 'done' },
        ],
      },
      dispatched,
    );
    expect(result.matched).toBe(true);
  });

  it('reports UNMATCHED (not incomplete) when an id is unknown', () => {
    const dispatched = dispatchedTasksFromSnapshot(parseContractPlan(PLAN));
    const result = contractMatchFromReviewer(
      { tasks: [{ id: 'I-1', status: 'done' }, { id: 'I-9', status: 'done' }] },
      dispatched,
    );
    expect(result.matched).toBe(false);
    expect(result.availableTaskIds).toEqual(['I-1', 'I-2']);
  });

  it('reports UNMATCHED on a count mismatch', () => {
    const dispatched = dispatchedTasksFromSnapshot(parseContractPlan(PLAN));
    const result = contractMatchFromReviewer({ tasks: [{ id: 'I-1', status: 'done' }] }, dispatched);
    expect(result.matched).toBe(false);
    expect(result.availableTaskIds).toEqual(['I-1', 'I-2']);
  });

  it('reports UNMATCHED on a duplicated id', () => {
    const dispatched = dispatchedTasksFromSnapshot(parseContractPlan(PLAN));
    const result = contractMatchFromReviewer(
      { tasks: [{ id: 'I-1', status: 'done' }, { id: 'I-1', status: 'done' }] },
      dispatched,
    );
    expect(result.matched).toBe(false);
  });

  it('distinguishes MATCHED-but-not-done from unmatched', () => {
    const dispatched = dispatchedTasksFromSnapshot(parseContractPlan(PLAN));
    const result = contractMatchFromReviewer(
      { tasks: [{ id: 'I-1', status: 'done' }, { id: 'I-2', status: 'failed' }] },
      dispatched,
    );
    expect(result.matched).toBe(true);
    expect(result.allDone).toBe(false);
  });

  it('reports UNMATCHED on malformed reviewer output rather than throwing', () => {
    const dispatched = dispatchedTasksFromSnapshot(parseContractPlan(PLAN));
    expect(contractMatchFromReviewer(null, dispatched).matched).toBe(false);
    expect(contractMatchFromReviewer({}, dispatched).matched).toBe(false);
    expect(contractMatchFromReviewer({ tasks: 'nope' }, dispatched).matched).toBe(false);
    expect(contractMatchFromReviewer({ tasks: [{ status: 'done' }] }, dispatched).matched).toBe(false);
  });

  /**
   * Selection and reviewer-matching must use ONE identity scheme. Selection used to compare
   * byte-exact titles while the reviewer contract compared ids — two ways to name one task, and
   * the selector side produced the same spurious `no_match` on a heading copied without its
   * `(← AC-…)` annotation.
   */
  describe('selector resolution shares the task-id scheme', () => {
    const dispatched = () => dispatchedTasksFromSnapshot(parseContractPlan(PLAN));

    it('accepts every spelling of the same task', () => {
      for (const sel of [
        'I-1',
        'i-1',
        'Task I-1',
        'Task I-1: Parse and validate frozen Contract Tasks (← AC-1.1)',
        '### Task I-1: Parse and validate frozen Contract Tasks',
        'Task I-1: a title the caller paraphrased',
      ]) {
        const r = resolveSelectors([sel], dispatched());
        expect(r.ok, sel).toBe(true);
        if (r.ok) expect(r.ids).toEqual(['I-1']);
      }
    });

    it('preserves caller order', () => {
      const r = resolveSelectors(['I-2', 'I-1'], dispatched());
      expect(r.ok && r.ids).toEqual(['I-2', 'I-1']);
    });

    it('rejects an unknown task and names the available ids (FR-11)', () => {
      const r = resolveSelectors(['I-9'], dispatched());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.availableTaskIds).toEqual(['I-1', 'I-2']);
        const msg = describeSelectorFailure(r);
        expect(msg).toContain('I-1');
        expect(msg).toContain('I-2');
      }
    });

    it('rejects two selectors resolving to the same task', () => {
      const r = resolveSelectors(['I-1', 'Task I-1: whatever'], dispatched());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.duplicated).toEqual(['I-1']);
    });

    it('rejects a selector carrying no id at all', () => {
      const r = resolveSelectors(['Do the thing'], dispatched());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.unresolvable).toEqual(['Do the thing']);
    });

    it('extractTaskId returns null when there is no id', () => {
      expect(extractTaskId('no identity here')).toBeNull();
      expect(extractTaskId('Task II-12: x')).toBe('II-12');
    });
  });
});
