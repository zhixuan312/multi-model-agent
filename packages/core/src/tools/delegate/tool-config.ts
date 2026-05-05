import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import { ReviewerEngine } from '../../review/reviewer-engine.js';
import {
  ReviewerPromptBuilder,
  specTemplate,
  qualityAPTemplate,
  diffTemplate,
} from '../../review/reviewer-engine.js';
import type { RunnerShell } from '../../providers/runner-shell.js';

export function registerDelegate(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'delegate',
    schema: inputSchema,
    toolCategory: 'artifact_producing',
    agentTypeDefault: 'standard',
    agentTypeOverridable: true,
    responseShapeName: 'BatchResponse',
  });
}

export function makeDelegateReviewer(shell: RunnerShell): ReviewerEngine {
  const builder = new ReviewerPromptBuilder({ spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate });
  return new ReviewerEngine(shell, builder);
}
