// packages/core/src/lifecycle/annotate-prompts.ts
//
// Two LLM prompt builders for the annotate stage (write route + read route).
// Both produce transcript-only prompts that ask for a JSON judgment matching
// AnnotatePayload. Helpers serialize upstream state without raw file contents
// or secrets (spec §15.2).

import type { LifecycleState } from './stage-plan-types.js';
import { reviewPayload } from './stage-plan-types.js';

export function annotatePromptWrite(state: LifecycleState): string {
  const ctx = serializeWriteContext(state);
  return `You are the annotator for a code-change task. Read the structured outputs from each prior stage and produce a single JSON judgment.

Input (truncated for budget):
\`\`\`json
${JSON.stringify(ctx, null, 2)}
\`\`\`

Rules:
1. Emit ONLY a JSON code block with these exact fields: completed (boolean), message (string, 1-3 sentences), findings (array passed through from upstream — you may dedupe identical entries and re-categorize severity ONLY; never invent new findings), summary, filesChanged, commitSha.
2. Set completed=true ONLY IF (the system applies these gates after your proposal):
  - implement stage advanced; AND
  - review is approved OR (changes_required + rework applied + no unaddressed findings) OR reviewPolicy=none; AND
  - commit gate kind is 'committed' or 'no_op'.
Worker self-assessment is recorded in telemetry but does not gate completion.
3. If completed=false, message must name a specific blocking gate or finding ID AND suggest a recovery action.
4. filesChanged and commitSha must come from commit.payload if it committed, else [] and null. Do not invent them.

Output the JSON block now.`;
}

export function annotatePromptRead(state: LifecycleState): string {
  const ctx = serializeReadContext(state);
  return `You are the annotator for a read-only investigation task. Read the structured output from the implement stage and produce a single JSON judgment.

Input:
\`\`\`json
${JSON.stringify(ctx, null, 2)}
\`\`\`

Rules:
1. Emit ONLY a JSON code block with these exact fields: completed (boolean), message (string, 1-3 sentences), findings (array passed through from implement.findings; dedupe identical entries and may re-categorize severity — never invent new findings), summary, filesChanged (must be []), commitSha (must be null).
2. Set completed=true ONLY IF: implement.workerSelfAssessment === 'done' AND (criteriaSucceeded.length > 0 OR criteriaErrors.length === 0).
3. If completed=false, message must name a specific blocking criterion error or note that the worker self-assessed as failed, AND suggest a recovery action.
4. Findings count is NOT a completion signal — empty findings on a read route means "I investigated and found nothing wrong," which is a valid completion when (2) holds.

Output the JSON block now.`;
}

// ───── helpers ─────

export function serializeWriteContext(state: LifecycleState): unknown {
  const last = (state as any).lastRunResult ?? null;
  return {
    task: { id: (state as any).task?.id ?? null, brief: { title: (state as any).task?.brief?.title ?? null, body: ((state as any).task?.brief?.body ?? '').slice(0, 2000) } },
    route: state.route,
    implement: last ? {
      workerSelfAssessment: last.workerStatus ?? null,
      summary: (last.summary ?? '').slice(0, 1000),
      filesChanged: last.filesChanged ?? [],
    } : null,
    review: {
      verdict: reviewPayload(state).verdict ?? null,
      findings: stripEvidence(reviewPayload(state).findings),
    },
    rework: {
      applied: (state as any).reworkApplied ?? false,
      error: (state as any).reworkError ?? null,
      unaddressedFindingIds: last?.unaddressedFindingIds ?? [],
    },
    commit: {
      committed: (state.gates?.commit?.payload as { kind?: 'committed' | 'no_op' } | undefined)?.kind === 'committed',
      skipReason: ((state.gates?.commit?.payload as { kind?: string; reason?: string } | undefined)?.kind === 'no_op'
        ? (state.gates?.commit?.payload as { reason?: string })?.reason ?? null
        : null),
      sha: last?.commitSha ?? null,
    },
  };
}

export function serializeReadContext(state: LifecycleState): unknown {
  const last = (state as any).lastRunResult ?? null;
  return {
    task: { id: (state as any).task?.id ?? null, brief: { title: (state as any).task?.brief?.title ?? null, body: ((state as any).task?.brief?.body ?? '').slice(0, 2000) } },
    route: state.route,
    implement: last ? {
      workerSelfAssessment: last.workerStatus ?? null,
      summary: (last.summary ?? '').slice(0, 1000),
      findings: stripEvidence(last.findings ?? []),
      citations: last.citations ?? [],
      criteriaSucceeded: last.criteriaSucceeded ?? [],
      criteriaErrors: last.criteriaErrors ?? [],
    } : null,
  };
}

export function stripEvidence<T extends { evidence?: string }>(items: T[]): T[] {
  return items.map(i => ({ ...i, evidence: undefined }));
}
