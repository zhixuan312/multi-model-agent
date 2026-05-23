import type { TaskEnvelope } from '../events/task-envelope.js';

type ReportInput = Pick<TaskEnvelope, 'route' | 'status' | 'findings' | 'headline'>;

/**
 * Renders a sealed task report to markdown for the terminal context block.
 * Content is sufficient for a delta follow-up: title (route + status),
 * the terminal headline text, then every finding with its full fields.
 * Read routes that carry synthesis/citations record them as findings, so
 * the findings list captures them. Zero-findings reports still emit a
 * non-empty title + headline block.
 */
export function renderTerminalReportMarkdown(env: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# ${env.route} — ${env.status}`);
  if (env.headline?.prefix) lines.push('', env.headline.prefix);
  lines.push('', `## Findings (${env.findings.length})`);
  if (env.findings.length === 0) {
    lines.push('', '_No findings._');
  } else {
    for (const f of env.findings) {
      const fa = f as { id: string; severity: string; category: string; claim: string; evidence?: string; suggestion?: string };
      lines.push('', `### ${fa.id} — [${fa.severity}] ${fa.category}`);
      lines.push(`**Claim:** ${fa.claim}`);
      if (fa.evidence) lines.push(`**Evidence:** ${fa.evidence}`);
      if (fa.suggestion) lines.push(`**Suggestion:** ${fa.suggestion}`);
    }
  }
  return lines.join('\n');
}
