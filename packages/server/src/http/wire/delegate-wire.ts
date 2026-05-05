// packages/server/src/http/wire/delegate-wire.ts
// IMPORTANT: server code MUST import core via the workspace package name (`@zhixuan92/multi-model-agent-core`),
// NOT deep relative paths like `../../../packages/core/src/...`. Deep relative imports cross the
// workspace boundary, break TypeScript's project-references graph, and bake an internal-path
// dependency into the npm-published artifact. The workspace alias resolves at build time to the
// same target and survives the publish step.
import {
  ReviewerEngine,
  ReviewerPromptBuilder,
  specTemplate,
  qualityAPTemplate,
  diffTemplate,
} from '@zhixuan92/multi-model-agent-core';
import type { RunnerShell } from '@zhixuan92/multi-model-agent-core';

export function makeDelegateReviewer(shell: RunnerShell): ReviewerEngine {
  const builder = new ReviewerPromptBuilder({ spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate });
  // ReviewerEngine receives the full ReviewerPromptBuilder facade, not a wrapped single-template adapter.
  // Stage handlers (Phase 4 rows 4.1, 4.6, 4.11) call builder.buildSpec / .buildQualityAP / .buildDiff
  // respectively — never collapse to a single buildSpec wrapper or rows 4.6 and 4.11 will silently
  // emit spec-template prompts at quality-review and diff-review stages.
  return new ReviewerEngine(shell, builder);
}
