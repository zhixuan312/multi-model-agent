/**
 * A Stop-hook goal must demand only what the type's output can contain.
 *
 * `buildGoalCondition` returned ONE reviewer goal for every task type, demanding "you have checked
 * for hallucinated findings", "every finding cites actual file:line or quoted text" and "you have
 * checked weight calibration against the skill definitions". Three write routes have no such field:
 * `delegate` is `{status, notes}`, `execute_plan` is `{tasks, notes}`, `journal_record` is
 * `{recorded, failed}`.
 *
 * That is not cosmetic. The Stop hook re-blocks the worker until the goal reads as satisfied, so
 * those reviewers were held against three clauses about a field their output does not have —
 * spending turns auditing findings that cannot exist, on routes whose real job is fixing the work
 * in the tree.
 *
 * The membership is derived from `REFINER_SCHEMAS`, so a route that gains or loses a findings array
 * changes the goal without anyone editing a list.
 */
import { describe, expect, it } from 'vitest';
import { buildGoalCondition } from '../../../packages/server/src/application/goal-conditions.js';
import { REFINER_SCHEMAS } from '../../../packages/core/src/unified/refiner-schemas.js';
import { TASK_TYPES } from '../../../packages/core/src/unified/type-registry.js';

/** Does this type's refiner answer carry a findings array? */
function hasFindings(type: string): boolean {
  const schema = REFINER_SCHEMAS[type as keyof typeof REFINER_SCHEMAS];
  const shape = (schema as { shape?: Record<string, unknown> } | undefined)?.shape;
  return shape !== undefined && 'findings' in shape;
}

const FINDINGS_CLAUSES = [/hallucinated findings/i, /every finding cites/i, /weight calibration/i];

describe('reviewer goals demand only fields the schema has', () => {
  it('the two groups are both non-empty', () => {
    // A floor: if every type had findings (or none did), the cases below would be vacuous.
    const withFindings = TASK_TYPES.filter((t) => hasFindings(t));
    const without = TASK_TYPES.filter((t) => !hasFindings(t));
    expect(withFindings.length).toBeGreaterThan(3);
    expect(without.length).toBeGreaterThan(2);
  });

  it.each([...TASK_TYPES])('%s reviewer goal matches its schema', (type) => {
    const goal = buildGoalCondition(type, 'reviewer', '');
    expect(goal, `no reviewer goal for ${type}`).toBeDefined();

    for (const clause of FINDINGS_CLAUSES) {
      if (hasFindings(type)) {
        expect(goal, `${type} has findings but its goal never mentions ${clause}`).toMatch(clause);
      } else {
        expect(
          goal,
          `${type} has no findings field, but its Stop-hook goal demands ${clause}`,
        ).not.toMatch(clause);
      }
    }
  });

  it('every reviewer goal still demands the shared basics', () => {
    for (const type of TASK_TYPES) {
      const goal = buildGoalCondition(type, 'reviewer', '')!;
      expect(goal, `${type} lost the criterion-coverage clause`).toMatch(/verified every criterion/i);
      expect(goal, `${type} lost the output-format clause`).toMatch(/json fenced block/i);
    }
  });
});
