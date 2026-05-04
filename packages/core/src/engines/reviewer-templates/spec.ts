import type { ReviewerTemplate } from '../reviewer-prompt-builder.js';

export const specTemplate: ReviewerTemplate = {
  build({ artifact, brief }) {
    return [
      'You are a spec compliance reviewer. Check whether the implementer satisfied the task exactly.',
      '',
      'Return a structured report. In ## Summary, state your verdict: "approved" or "changes_required".',
      'In ## Deviations from brief, list specific issues found.',
      'In ## Unresolved, list items needing parent judgment.',
      'Check: scope coverage, acceptance criteria met, required markers present, no out-of-scope changes.',
      'Completeness: if the task describes multiple files, sections, handlers, or components to modify, check whether each required target was adequately addressed. A target may be addressed by direct edit, by a shared-code change that covers it, or by already being correct. Only flag changes_required when there is positive evidence of omission — e.g., the task names targets A, B, and C, but only A and B appear in the modified files with no indication that C was addressed. Do not flag changes_required merely because a target\'s file is absent from the review bundle — the target may have been correctly left unchanged.',
      '',
      '## Brief (what was asked)',
      brief,
      '',
      '## Artifact (implementation output)',
      artifact,
      '',
      'Output your review as a single fenced JSON code block:',
      '```json',
      '{',
      '  "verdict": "approved" | "concerns" | "changes_required" | "error" | "skipped",',
      '  "findings": [',
      '    {',
      '      "severity": "critical" | "high" | "medium" | "low",',
      '      "category": "<string>",',
      '      "description": "<string>",',
      '      "evidence": "<string>"',
      '    }',
      '  ],',
      '  "concernCategories": ["<string>"],',
      '  "findingsBySeverity": { "critical": 0, "high": 0, "medium": 0, "low": 0 }',
      '}',
      '```',
    ].join('\n');
  },
};
