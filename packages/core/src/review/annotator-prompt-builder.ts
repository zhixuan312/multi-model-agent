import { buildAnnotatorRubric, type AnnotatorPromptContext, type AnnotatorTemplate } from './templates/annotator-shared.js';

export type AnnotatorRoute = 'audit' | 'review' | 'verify' | 'debug' | 'investigate';

export class AnnotatorPromptBuilder {
  constructor(
    private templates: Record<AnnotatorRoute, AnnotatorTemplate>,
  ) {}

  build(route: AnnotatorRoute, ctx: AnnotatorPromptContext): string {
    return assembleAnnotatorPrompt(this.templates[route], ctx);
  }
}

/**
 * Trim the implementer brief down to the "what was asked" essentials
 * before sending to the annotator. The annotator does NOT need the
 * finding-format spec (it has its own format spec via buildAnnotatorRubric)
 * or the delta-mode instructions. Sending the full brief wastes
 * 1-3KB context per call and mildly distracts the model.
 *
 * Two prompt shapes covered:
 *
 *   1. **Goal-first** (audit / review / verify / debug):
 *      `<goal + scope>\n\n<format spec at the END>` — slice off the
 *      format spec, keep everything before it.
 *
 *   2. **Spec-first** (investigate): the brief opens with the
 *      structured-format instructions and ends with `Question: <text>`.
 *      Pull the question line out as the compact brief.
 *
 * If neither shape applies, the brief is returned unchanged.
 */
export function trimBriefForAnnotator(brief: string): string {
  if (typeof brief !== 'string' || brief.length === 0) return brief;

  // Shape 2 (investigate): pull the `Question: ...` line out.
  const questionMatch = brief.match(/^\s*Question:\s+(.+)$/m);
  if (questionMatch) {
    return `Question: ${questionMatch[1].trim()}`;
  }

  // Shape 1 (audit / review / verify / debug): slice before the first
  // format-spec marker. Each per-tool implementer prompt structures
  // the goal at the top, format spec at the bottom — so this gives
  // the annotator the goal + scope without the duplicated format
  // instructions.
  const markers = [
    /\nProduce a narrative .* report\./i,
    /\nFor each checklist item, use this EXACT/i,
    /\nUse hypothesis-driven debugging\./i,
    /\n## Finding 1:/i,
    /\nUse this EXACT per-finding format/i,
  ];
  let cut = brief.length;
  for (const m of markers) {
    const idx = brief.search(m);
    if (idx >= 0 && idx < cut) cut = idx;
  }
  return brief.slice(0, cut).trim();
}

export function assembleAnnotatorPrompt(template: AnnotatorTemplate, ctx: AnnotatorPromptContext): string {
  // Tool sweep #11: trim the brief — the format-spec section is
  // duplicated by buildAnnotatorRubric below, so sending it again is
  // redundant + costly.
  const compactBrief = trimBriefForAnnotator(ctx.brief);

  // Multi-narrative merge mode: each sub-worker covered ONE criterion.
  // The annotator dedups overlapping findings and recalibrates severity
  // against the shared SEVERITY_LADDER. Single-narrative inputs (e.g.
  // a route that hasn't migrated to fan-out) take the same path with N=1.
  const sections = ctx.workerOutputs.map(o =>
    `--- Sub-worker for ${o.criterion} ---\n${o.narrative}`,
  ).join('\n\n');

  const mergeInstructions = ctx.workerOutputs.length > 1
    ? `\n## Merge instructions\n\nThe worker output below is N narratives, each from a sub-worker that covered ONE criterion of the failure-mode taxonomy. Your job:\n1. Combine findings across all narratives into one list.\n2. Group findings by (file, line, claim essence). When two sub-workers reported the same underlying issue from different angles, KEEP ONE — pick the higher-severity wording and merge any non-redundant evidence.\n3. Recalibrate severity using the shared severity ladder so a sub-worker that inflated within its narrow scope is rebucketed against the global picture.\n4. Drop any narrative that contained no findings (these are valid empty results, not parse failures).\n\n`
    : '';

  return `You are reviewing a ${template.role} produced by a worker.

The user requested a ${template.role}. The brief was:

${compactBrief}

## On-brief check (per finding)

${template.onBriefCheck}
${mergeInstructions}
## Worker output to extract findings from

${sections}

${buildAnnotatorRubric(template)}`;
}
