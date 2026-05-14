import type { HeadlineTemplate } from '../headline-composer.js';
import { countHighOrCritical, parseNarrativeFindings } from '../severity.js';

/**
 * Compose a terminal headline for debug.
 *
 * Tool sweep #4 rewrite: bring debug into the same shape as audit and
 * review/verify so operator-facing logs stay consistent across tools:
 *
 *     [ok]    debug <path>: 3 findings (0 high)
 *     [error] debug: 1 findings (1 high)
 *     [ok]    debug completed
 *
 * Previously emitted "debug: 1/1 tasks complete" with no status prefix
 * and no findings count — operator could not tell ok from error and
 * had no signal about how many real findings landed.
 *
 * Findings source (v4.5.2+): parseNarrativeFindings(runResult.output)
 * recovers `## Finding N:` blocks directly from the implementer's
 * narrative.
 *
 * Note: debug's reportSchema.parse is intentionally a thrower (the tool
 * doesn't emit a structured report), so `report` is always notApplicable
 * here — there's no `report.findings` source to read.
 */
export const debugHeadlineTemplate: HeadlineTemplate = {
  compose({ status, runResult, task }) {
    let findings: Array<{ severity?: unknown }> = [];
    if (typeof runResult?.output === 'string') {
      const narrative = parseNarrativeFindings(runResult.output);
      if (narrative.length > 0) findings = narrative;
    }

    const path =
      (task as { filePaths?: string[] } | undefined)?.filePaths?.[0] || '';

    if (findings.length === 0 && !path) {
      return `[${status}] debug completed`;
    }

    const high = countHighOrCritical(findings);
    return path
      ? `[${status}] debug ${path}: ${findings.length} findings (${high} high)`
      : `[${status}] debug: ${findings.length} findings (${high} high)`;
  },
};
