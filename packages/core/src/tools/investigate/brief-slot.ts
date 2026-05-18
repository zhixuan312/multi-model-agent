import type { Input } from './schema.js';
import {
  INVESTIGATE_PURPOSE_ORIENTATION,
  EVIDENCE_RULE_INVESTIGATE,
  SCOPE_RULE_INVESTIGATE,
  ANNOTATOR_AWARENESS_INVESTIGATE,
  INVESTIGATE_FAILURE_MODES,
  CONFIDENCE_REMINDER_INVESTIGATE,
} from './implementer-criteria.js';

// ── Enriched input: the handler resolves context blocks and canonicalizes
//    file paths before passing them here, so briefSlot operates on resolved data.

export interface ResolvedContextBlock {
  id: string;
  content: string;
}

export interface EnrichedInvestigateInput extends Input {
  resolvedContextBlocks: ResolvedContextBlock[];
  canonicalizedFilePaths: string[];
  relativeFilePathsForPrompt: string[];
}

export interface InvestigateBrief {
  /** The user's original question — drives the headline text. */
  question: string;
  /**
   * The fully compiled implementer prompt (template + question + anchors +
   * context blocks). Stored here for buildTaskSpec to forward as
   * TaskSpec.prompt, but deliberately NOT named `prompt`/`brief`. The
   * task-executor's `taskBrief` resolution chain reads
   * `briefs[0].prompt ?? .brief ?? .question`; a `prompt` field here would
   * cause the headline to be the prompt-template instructions (the tool
   * sweep #5 bug — headline read 'Investigation: "Produce a narrative
   * investigation report. Number each findin…"'). Falling through to
   * `question` is the desired behavior.
   */
  compiledPrompt: string;
  filePaths: string[];
  contextBlockIds: string[];
  tools?: 'none' | 'readonly';
}

function compilePrompt(input: EnrichedInvestigateInput): string {
  const promptParts: string[] = [];
  // Orientation goes FIRST — the worker needs to know why this
  // investigation exists (caller will act on this answer; wrong file
  // path becomes a bug) before reading the format spec / taxonomy.
  // Without it, workers default to plausible-sounding answers with
  // shaky citations.
  promptParts.push(INVESTIGATE_PURPOSE_ORIENTATION);
  promptParts.push(
    [
      'Produce an investigation report in this EXACT structured format. The deterministic',
      'parser extracts findings, summary, and confidence by section — do NOT emit JSON, and',
      'do NOT use a numbered-list narrative. Sections MUST use h2 headers (`##`).',
      '',
      '## Summary',
      'One paragraph stating the answer to the question, in plain prose. This is the synthesis',
      'a human reads first; do not omit it.',
      '',
      '## Finding 1: <one-line title — the candidate answer or sub-answer in one line>',
      '- Severity: critical | high | medium | low  (your confidence in this answer: critical=direct verbatim citation; high=clearly inferable from cited source; medium=single interpretation step required; low=weak inference)',
      '- Category: <category — e.g. "control-flow", "data-shape", "dependency", "side-effect", or any short label that classifies this answer>',
      '- Evidence: <one-paragraph explanation that MUST include at least one `<file>:<line>` or `<file>:<line>-<line>` citation. The parser drops findings whose Evidence contains no file:line reference. Quote the relevant code or doc when helpful. If the question is genuinely project-level with no code evidence, emit Severity: low and write "no code citation — project-level inference based on …" with named files referenced inline.>',
      '- Suggestion: <one-line follow-up — a fix, how to verify, or where to look next; optional but encouraged>',
      '',
      '## Finding 2: ... (one block per candidate answer)',
      '',
      'Number findings sequentially starting at 1. Severity/Category/Evidence/Suggestion bullets are on their own lines with the labels exactly as shown. Emit AT LEAST ONE Finding — empty/narrative-only responses are workflow errors and will be discarded.',
      '',
      '## Confidence',
      'One of high, medium, or low, optionally followed by ` — <one-line rationale>`. This is the OVERALL confidence in your synthesis; per-finding confidence lives in each Finding\'s Severity. Do NOT wrap the level in backticks; emit it as plain text.',
      '',
      '## Outcome',
      'One of: found | not_applicable. Emit `found` whenever you produced at least one Finding (the normal case). Emit `not_applicable` only when the question itself does not apply to this codebase.',
      '',
      '## Unresolved',
      'Optional bullets describing follow-up questions; write `(none)` if there are none.',
      'Prefix a bullet with `[needs_context]` if it requires the caller to supply more',
      'information before the question can be answered.',
    ].join('\n'),
  );
  for (const block of input.resolvedContextBlocks) {
    promptParts.push(block.content);
  }
  if (input.relativeFilePathsForPrompt.length > 0) {
    promptParts.push(
      'Anchor paths to start from (you may also read beyond these):\n' +
      input.relativeFilePathsForPrompt.map(p => `- ${p}`).join('\n'),
    );
  }
  promptParts.push(`Question: ${input.question}`);
  if (input.resolvedContextBlocks.length > 0) {
    promptParts.push(
      'A prior investigation report is provided as context above. Refine or extend that investigation. In your output, mark which prior unresolved questions you resolved this round and which remain open.',
    );
  }
  // Tool sweep #12: shared rubric. Investigate doesn't use the
  // SEVERITY_LADDER (its findings are citations, not severity-rated)
  // but evidence-grounding + scope-discipline + annotator-awareness
  // apply just as much. Workers that cite hallucinated lines or
  // speculate about unread files now have the rubric inline.
  promptParts.push(
    INVESTIGATE_FAILURE_MODES,
    CONFIDENCE_REMINDER_INVESTIGATE,
    EVIDENCE_RULE_INVESTIGATE,
    SCOPE_RULE_INVESTIGATE,
    ANNOTATOR_AWARENESS_INVESTIGATE,
  );
  return promptParts.join('\n\n');
}

export const investigateBriefSlot = (input: EnrichedInvestigateInput): InvestigateBrief[] => {
  const compiledPrompt = compilePrompt(input);
  return [{
    question: input.question,
    compiledPrompt,
    filePaths: input.canonicalizedFilePaths,
    contextBlockIds: input.contextBlockIds ?? [],
    tools: input.tools,
  }];
};
