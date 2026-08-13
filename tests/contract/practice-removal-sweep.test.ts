import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { taskInputSchema } from '@zhixuan92/multi-model-agent-core';

const root = resolve(import.meta.dirname, '../..');
const retiredAssets = ['packages/core/src/skills/debug/implement-software.md', 'packages/core/src/skills/execute_plan/implement-software.md', 'packages/core/src/skills/plan/implement-software.md', 'packages/core/src/skills/review/implement-software.md'];
const scopedFiles = [
  'packages/core/src/unified/task-input-schema.ts', 'packages/core/src/unified/task-registry.ts', 'packages/server/src/application/task-identity.ts', 'packages/server/src/application/execution-runtime.ts', 'packages/server/src/mcp/tool-surface.ts',
  'packages/server/src/skills/_shared/response-shape.md', 'packages/server/src/skills/mma-debug/SKILL.md', 'packages/server/src/skills/mma-execute-plan/SKILL.md', 'packages/server/src/skills/mma-flow/SKILL.md', 'packages/server/src/skills/mma-plan/SKILL.md', 'packages/server/src/skills/mma-review/SKILL.md',
  'plugin/commands/flow.md', 'plugin/skills/debug/SKILL.md', 'plugin/skills/execute-plan/SKILL.md', 'plugin/skills/plan/SKILL.md', 'plugin/skills/review/SKILL.md', 'plugin/skills/audit/SKILL.md',
  'tests/contract/practice-routing-contract.test.ts', 'tests/skills/practice-routing-reachability.test.ts', 'tests/skills/software-practice-regression.test.ts',
  // The release smoke harness and public docs are wired/committed surfaces, not internal source —
  // a caller reads README.md/ARCHITECTURE.md and `smoke:full` dispatches these scripts for real.
  // Both stayed outside every earlier sweep, so both kept naming the retired field past removal;
  // scoping them here means the scan can never again pass while either drifts.
  'scripts/full-smoke/config.mjs', 'scripts/full-smoke/dispatch.mjs', 'scripts/full-smoke/verify.mjs', 'README.md', 'docs/ARCHITECTURE.md',
];

describe('practice removal sweep', () => {
  it('removes the retired public mechanism without changing audit subtype', () => {
    expect(taskInputSchema.safeParse({ type: 'review', target: { paths: ['/tmp/a.ts'] }, practice: 'software' }).success).toBe(false);
    expect(taskInputSchema.safeParse({ type: 'audit', target: { inline: 'x' }, subtype: 'plan' }).success).toBe(true);
    for (const asset of retiredAssets) expect(existsSync(resolve(root, asset))).toBe(false);
    for (const file of scopedFiles) {
      const text = readFileSync(resolve(root, file), 'utf8');
      expect(text).not.toMatch(/\bpracticeOf\b|\bskillSelectorOf\b|routing\.practice|"practice"\s*:|`practice`|practice:\s*'software'|implement-software\.md/);
    }
    expect(existsSync(resolve(root, 'packages/core/src/methods/software-change/guidance.md'))).toBe(true);
    expect(readFileSync(resolve(root, 'packages/core/src/methods/software-change/guidance.md'), 'utf8')).toMatch(/Caller tracing[\s\S]*Error-path review[\s\S]*Security-sink review[\s\S]*Schema conformance[\s\S]*Test adequacy/);
  });
});