export type PlanTaskVerdict = 'EXECUTABLE' | 'PARTIAL' | 'BLOCKED';

export interface PlanAuditFinding {
  taskId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export function derivePlanTaskVerdicts(
  findings: ReadonlyArray<PlanAuditFinding>,
): Map<string, PlanTaskVerdict> {
  const out = new Map<string, PlanTaskVerdict>();
  for (const f of findings) {
    const prior = out.get(f.taskId);
    if (f.severity === 'critical') {
      out.set(f.taskId, 'BLOCKED');
    } else if (f.severity === 'high') {
      if (prior !== 'BLOCKED') out.set(f.taskId, 'PARTIAL');
    } else if (!prior) {
      out.set(f.taskId, 'EXECUTABLE');
    }
  }
  return out;
}

export interface PlanAuditSummary {
  text: string;
  executable: string[];
  partial: string[];
  blocked: string[];
  nextBlocker: string | null;
}

export function composePlanAuditSummary(
  allTaskIds: ReadonlyArray<string>,
  verdicts: ReadonlyMap<string, PlanTaskVerdict>,
): PlanAuditSummary {
  const executable: string[] = [];
  const partial: string[] = [];
  const blocked: string[] = [];
  for (const id of allTaskIds) {
    const v = verdicts.get(id) ?? 'EXECUTABLE';
    if (v === 'BLOCKED') blocked.push(id);
    else if (v === 'PARTIAL') partial.push(id);
    else executable.push(id);
  }
  const sortedBlocked = [...blocked].sort();
  const nextBlocker = sortedBlocked[0] ?? null;
  const lines = [
    `${allTaskIds.length} tasks audited:`,
    `  EXECUTABLE: ${executable.length}${executable.length ? ` (${executable.join(', ')})` : ''}`,
    `  PARTIAL:    ${partial.length}${partial.length ? ` (${partial.join(', ')})` : ''}`,
    `  BLOCKED:    ${blocked.length}${blocked.length ? ` (${blocked.join(', ')})` : ''}`,
  ];
  if (nextBlocker) {
    lines.push('', `Next blocker: ${nextBlocker}`);
  }
  return { text: lines.join('\n'), executable, partial, blocked, nextBlocker };
}
