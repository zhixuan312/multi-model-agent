import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolSurfaceRegistry } from '../../../packages/core/src/tool-surface/tool-surface-registry.js';
import { buildStagePlan } from '../../../packages/core/src/lifecycle/stage-plan-builder.js';
import { registerDelegate } from '../../../packages/core/src/tools/delegate/tool-config.js';
import { registerAudit } from '../../../packages/core/src/tools/audit/tool-config.js';
import { registerReview } from '../../../packages/core/src/tools/review/tool-config.js';
import { registerVerify } from '../../../packages/core/src/tools/verify/tool-config.js';
import { registerDebug } from '../../../packages/core/src/tools/debug/tool-config.js';
import { registerExecutePlan } from '../../../packages/core/src/tools/execute-plan/tool-config.js';
import { registerRetry } from '../../../packages/core/src/tools/retry/tool-config.js';
import { registerInvestigate } from '../../../packages/core/src/tools/investigate/tool-config.js';
import { registerExplore } from '../../../packages/core/src/tools/explore/tool-config.js';
import { registerContextBlock } from '../../../packages/core/src/tools/register-context-block/tool-config.js';

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = resolve(here, '../goldens/architecture/workflow-matrix.json');

interface MatrixGolden {
  tools: Array<{ routeName: string; toolCategory: string; agentTypeDefault: string; agentTypeOverridable: boolean; responseShapeName: string }>;
  stagePlans: Record<string, Array<{ rowId: string; stageName: string; schemaStage?: string; isRework: boolean; runOnTerminal: boolean; handlerKey: string }>>;
}

function buildMatrix(): MatrixGolden {
  const registry = new ToolSurfaceRegistry();
  registerDelegate(registry);
  registerAudit(registry);
  registerReview(registry);
  registerVerify(registry);
  registerDebug(registry);
  registerExecutePlan(registry);
  registerRetry(registry);
  registerInvestigate(registry);
  registerExplore(registry);
  registerContextBlock(registry);

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

  const categories = ['artifact_producing', 'read_only', 'research'] as const;
  const stagePlans: MatrixGolden['stagePlans'] = {};
  for (const cat of categories) {
    const plan = buildStagePlan(cat);
    stagePlans[cat] = plan.rows.map((r) => ({
      rowId: r.rowId,
      stageName: r.stageName,
      ...(r.schemaStage ? { schemaStage: r.schemaStage } : {}),
      isRework: r.isRework,
      runOnTerminal: r.runOnTerminal === true,
      handlerKey: r.handlerKey,
    }));
  }
  return { tools, stagePlans };
}

describe('contract: workflow matrix', () => {
  it('tool registry + per-category stage plans match the architecture golden', () => {
    const actual = buildMatrix();
    if (process.env.CAPTURE_GOLDEN === '1') {
      writeFileSync(goldenPath, JSON.stringify(actual, null, 2) + '\n');
    }
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as MatrixGolden;
    expect(actual).toEqual(golden);
  });
});
