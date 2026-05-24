import type { Input } from './schema.js';
import type { ReviewPolicy } from '../../types/review-policy.js';
import {
  DELEGATE_PURPOSE_ORIENTATION,
  DELEGATE_SCOPE_RULE,
  DELEGATE_FAILURE_MODES,
  COMPLETENESS_REMINDER_DELEGATE,
  WORKER_SELF_ASSESSMENT_DELEGATE,
  TURN_BUDGET_DELEGATE,
} from './implementer-criteria.js';

export interface DelegateBrief {
  prompt: string;
  /** Raw caller task text (NOT the compiled prompt) — the clean source for the
   *  deterministic commit subject (compose-commit-message). */
  taskDescriptor: string;
  done?: string;
  filePaths?: string[];
  agentType: 'standard' | 'complex';
  reviewPolicy: ReviewPolicy;
  contextBlockIds?: string[];
  outputTargets?: string[];
}

/**
 * Compile a delegate worker prompt — slimmed in 4.2.3 from ~9 KB to
 * ~3 KB. Cheap workers respond to long layered prompts by spinning on
 * discovery; this slim version keeps only load-bearing rules. The spec
 * reviewer (complex tier) catches scope creep / partial fixes and emits
 * targeted instructions for rework; the rework round applies them
 * mechanically. The worker no longer needs to anticipate the reviewer's
 * full rubric — that was REVIEWER_AWARENESS_AP, dropped.
 *
 * Structure (top-down):
 *   1. Orientation (smallest complete change)
 *   2. The caller's brief (`prompt`)
 *   3. File constraint (when filePaths is set)
 *   4. Scope rule
 *   5. Top-4 failure-mode taxonomy
 *   6. Brief-vs-diff walk
 */
function compileDelegatePrompt(input: { prompt: string; filePaths?: string[] }): string {
  const filePathsClause = input.filePaths && input.filePaths.length > 0
    ? `\n\nFILE CONSTRAINT: write to exactly these path(s), no others, no renames: ${input.filePaths.map((p) => `\`${p}\``).join(', ')}.\n- Existing files in this list are pre-verified to read and modify.\n- Non-existent paths in this list are explicit OUTPUT TARGETS — create them.\n- Files NOT in this list are off-limits to write unless the brief\'s task genuinely requires touching them (call out the deviation in your summary).`
    : '';
  return [
    DELEGATE_PURPOSE_ORIENTATION,
    '',
    'Brief from the caller (this is the contract — implement exactly what it says):',
    '',
    input.prompt,
    filePathsClause,
    '',
    DELEGATE_SCOPE_RULE,
    '',
    DELEGATE_FAILURE_MODES,
    '',
    COMPLETENESS_REMINDER_DELEGATE,
    '',
    WORKER_SELF_ASSESSMENT_DELEGATE,
    '',
    TURN_BUDGET_DELEGATE,
  ].join('\n');
}

export const delegateBriefSlot = (input: Input): DelegateBrief[] =>
  input.tasks.map((t) => ({
    prompt: compileDelegatePrompt({ prompt: t.prompt, filePaths: t.filePaths }),
    taskDescriptor: t.prompt, // raw caller text → clean commit subject
    done: t.done,
    filePaths: t.filePaths,
    // Defaults are applied authoritatively by the Zod schema (.default()),
    // so the parsed input always carries agentType/reviewPolicy.
    agentType: t.agentType,
    reviewPolicy: t.reviewPolicy,
    contextBlockIds: t.contextBlockIds,
    outputTargets: t.outputTargets,
  }));
