// v5 workflow matrix contract — tool registry + v5 STAGE_PLAN structure.
// Replaces the legacy buildStagePlan-rows contract; the v5 STAGE_PLAN is a
// flat StageDefinition[] of 9 stages with applicableRoutes + shouldRun
// gating, not per-row runConditions.

import { describe, it, expect } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildToolSurfaceRegistry } from '../../../packages/core/src/tool-surface/register-all-tools.js';
import { STAGE_PLAN } from '../../../packages/core/src/lifecycle/stage-plan-builder.js';
import type { StageDefinition } from '../../../packages/core/src/lifecycle/stage-io.js';

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = resolve(here, '../goldens/architecture/workflow-matrix.json');

interface MatrixGolden {
  tools: Array<{ routeName: string; toolCategory: string; agentTypeDefault: string; agentTypeOverridable: boolean; responseShapeName: string }>;
  stagePlan: Array<{ name: string; applicableRoutes: 'all' | readonly string[]; runOnHalt: boolean }>;
}

function buildMatrix(): MatrixGolden {
  const registry = buildToolSurfaceRegistry();

  const tools = registry
    .list()
    .map((e) => ({
      routeName: e.routeName,
      toolCategory: e.toolCategory,
      agentTypeDefault: e.agentTypeDefault,
      agentTypeOverridable: e.agentTypeOverridable,
      responseShapeName: e.responseShapeName,
    }))
    .sort((a, b) => a.routeName.localeCompare(b.routeName));

  const stagePlan = STAGE_PLAN.map((s) => {
    const def = s as StageDefinition;
    return {
      name: def.name,
      applicableRoutes: def.applicableRoutes === 'all' ? 'all' : [...(def.applicableRoutes as readonly string[])],
      runOnHalt: def.runOnHalt === true,
    };
  });

  return { tools, stagePlan };
}

describe('contract: workflow matrix (v5)', () => {
  it('tool registry + v5 STAGE_PLAN structure match the architecture golden', () => {
    const actual = buildMatrix();
    if (process.env.CAPTURE_GOLDEN === '1') {
      writeFileSync(goldenPath, JSON.stringify(actual, null, 2) + '\n');
    }
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as MatrixGolden;
    expect(actual).toEqual(golden);
  });
});
