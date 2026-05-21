import type { CommitFields } from '../reporting/structured-report.js';

export function composeCommitMessage(c: CommitFields): string {
  const subject = `${c.type}${c.scope ? `(${c.scope})` : ''}: ${c.subject}`;
  return c.body ? `${subject}\n\n${c.body}` : subject;
}
